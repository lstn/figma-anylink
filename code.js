// This plugin allows adding hyperlinks to any Figma object by creating
// a hidden text node behind the object with the hyperlink

figma.showUI(__html__, { width: 500, height: 500 });

// ClientStorage key prefix
const STORAGE_KEY_PREFIX = 'anylink_links_';

// Simple hash function for strings
function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36);
}

// Create a hash identifier for the current file based on figma.root properties
function getFileHash() {
  // Combine stable properties of figma.root to create a unique identifier
  const root = figma.root;
  const fileKey = figma.fileKey || '';
  
  // Create a string from stable root properties
  const hashInput = [
    fileKey,
    root.id,
    root.name || '',
    root.type || '',
    root.children.length.toString()
  ].join('|');
  
  return hashString(hashInput);
}

// Get file identifier (fileKey or fallback to hash)
function getFileId() {
  return figma.fileKey || 'local_' + getFileHash();
}

// Get storage key for current file
function getStorageKey() {
  return STORAGE_KEY_PREFIX + getFileId();
}

// Load links from clientStorage for current file
async function loadLinksFromStorage() {
  try {
    const storageKey = getStorageKey();
    const links = await figma.clientStorage.getAsync(storageKey);
    return links || {};
  } catch (error) {
    console.error('Error loading links from storage:', error);
    return {};
  }
}

// Save links to clientStorage for current file
async function saveLinksToStorage(links) {
  try {
    const storageKey = getStorageKey();
    await figma.clientStorage.setAsync(storageKey, links);
  } catch (error) {
    console.error('Error saving links to storage:', error);
  }
}

// Add or update a link in storage
async function saveLinkToStorage(nodeId, nodeName, textNodeId, groupId, url) {
  const links = await loadLinksFromStorage();
  links[nodeId] = {
    url: url,
    nodeName: nodeName,
    textNodeId: textNodeId,
    groupId: groupId,
    fileId: getFileHash(),
    fileName: figma.root.name,
    timestamp: Date.now()
  };
  await saveLinksToStorage(links);
  await refreshLinksList();
}

// Remove a link from storage
async function removeLinkFromStorage(nodeId) {
  const links = await loadLinksFromStorage();
  delete links[nodeId];
  await saveLinksToStorage(links);
  await refreshLinksList();
}

// Delete a link: remove text node, ungroup, and remove from storage
async function deleteLink(nodeId) {
  try {
    const links = await loadLinksFromStorage();
    const linkData = links[nodeId];
    
    if (!linkData) {
      figma.notify('Link not found in storage');
      return;
    }
    
    // Find the group and text node
    function findNodeById(currentNode, targetId) {
      if (currentNode.id === targetId) {
        return currentNode;
      }
      if ('children' in currentNode) {
        for (const child of currentNode.children) {
          const found = findNodeById(child, targetId);
          if (found) return found;
        }
      }
      return null;
    }
    
    let group = null;
    let textNode = null;
    let originalNode = null;
    
    // Search for the group
    for (const page of figma.root.children) {
      if (page.type === 'PAGE') {
        if (linkData.groupId) {
          group = findNodeById(page, linkData.groupId);
        }
        if (linkData.textNodeId) {
          textNode = findNodeById(page, linkData.textNodeId);
        }
        if (group || textNode) break;
      }
    }
    
    // If we found the group, get the original node from it
    if (group && 'children' in group) {
      for (const child of group.children) {
        if (child.id !== linkData.textNodeId) {
          originalNode = child;
          break;
        }
      }
    }
    
    // Remove the text node (if it still exists)
    if (textNode) {
      try {
        // Check if node still exists by trying to access its parent
        if (textNode.parent) {
          textNode.remove();
        }
      } catch (e) {
        // Node might already be removed, that's okay
        console.log('Text node already removed or doesn\'t exist:', e.message);
      }
    }
    
    // Ungroup: move original node to group's parent and remove group
    if (group && originalNode) {
      try {
        // Check if group still exists
        if (!group.parent) {
          // Group already removed, just clean up storage
          await removeLinkFromStorage(nodeId);
          figma.notify(`Removed hyperlink from ${linkData.nodeName || 'object'}`);
          return;
        }
        
        const groupParent = group.parent;
        
        // Check if original node still exists and is in the group
        if (originalNode.parent === group) {
          const groupIndex = groupParent.children.indexOf(group);
          
          // Move original node to group's parent
          if (groupIndex >= 0) {
            groupParent.insertChild(groupIndex, originalNode);
          } else {
            groupParent.appendChild(originalNode);
          }
        }
        
        // Remove the group (only if it still exists)
        if (group.parent) {
          group.remove();
        }
      } catch (e) {
        console.error('Error ungrouping:', e);
        // If ungrouping fails, try to just remove from storage
        // The nodes might have been manually deleted
        try {
          // Check if group still exists before trying fallback
          if (group.parent && originalNode && originalNode.parent === group) {
            const groupParent = group.parent;
            if (groupParent && 'children' in groupParent) {
              groupParent.appendChild(originalNode);
              if (group.parent) {
                group.remove();
              }
            }
          }
        } catch (e2) {
          console.error('Error in fallback ungroup:', e2);
          // Even if ungrouping fails, still remove from storage
        }
      }
    }
    
    // Remove from storage
    await removeLinkFromStorage(nodeId);
    
    figma.notify(`Removed hyperlink from ${linkData.nodeName || 'object'}`);
  } catch (error) {
    figma.notify(`Error deleting link: ${error.message}`);
    console.error('Error in deleteLink:', error);
  }
}

// Get URL from text node
function getUrlFromTextNode(textNode) {
  try {
    const hyperlink = textNode.getRangeHyperlink(0, 1);
    if (hyperlink && hyperlink.type === 'URL') {
      return hyperlink.value;
    }
  } catch (e) {
    // Couldn't read hyperlink
  }
  return null;
}

// Scan all nodes recursively to find hyperlinks
async function scanAllHyperlinks() {
  const links = await loadLinksFromStorage();
  const foundLinks = {};
  
  function scanNode(node) {
    // Check if this node has a hyperlink
    const existingLink = findExistingHyperlink(node);
    if (existingLink) {
      const url = getUrlFromTextNode(existingLink);
      if (url) {
        // Find the group (parent of both node and textNode)
        const groupId = existingLink.parent && existingLink.parent.type === 'GROUP' 
          ? existingLink.parent.id 
          : null;
        foundLinks[node.id] = {
          url: url,
          nodeName: node.name || 'Unnamed',
          textNodeId: existingLink.id,
          groupId: groupId,
          fileId: getFileHash(),
          fileName: figma.root.name,
          timestamp: (links[node.id] && links[node.id].timestamp) || Date.now()
        };
      }
    }
    
    // Recursively scan children
    if ('children' in node) {
      for (const child of node.children) {
        scanNode(child);
      }
    }
  }
  
  // Scan all pages
  for (const page of figma.root.children) {
    if (page.type === 'PAGE') {
      for (const child of page.children) {
        scanNode(child);
      }
    }
  }
  
  // Update storage with found links (merge with existing timestamps)
  await saveLinksToStorage(foundLinks);
  return foundLinks;
}

// Refresh and send links list to UI
async function refreshLinksList() {
  const links = await loadLinksFromStorage();
  const currentFileHash = getFileHash();
  
  // Filter links to only show those from the current file
  // Also filter out legacy links that don't have fileId
  const linksArray = Object.entries(links)
    .filter(([nodeId, linkData]) => linkData && linkData.fileId === currentFileHash)
    .map(([nodeId, linkData]) => ({
      nodeId: nodeId,
      url: linkData.url,
      nodeName: linkData.nodeName,
      textNodeId: linkData.textNodeId,
      groupId: linkData.groupId || null,
      fileName: linkData.fileName || figma.root.name
    }));
  
  figma.ui.postMessage({
    type: 'links-list-update',
    links: linksArray,
    currentFileName: figma.root.name
  });
}

// Find and select a node by ID
async function selectNodeById(nodeId) {
  function findNodeById(node, targetId) {
    if (node.id === targetId) {
      return node;
    }
    
    if ('children' in node) {
      for (const child of node.children) {
        const found = findNodeById(child, targetId);
        if (found) {
          return found;
        }
      }
    }
    
    return null;
  }
  
  // Search through all pages
  for (const page of figma.root.children) {
    if (page.type === 'PAGE') {
      const node = findNodeById(page, nodeId);
      if (node) {
        // Select the node and viewport to it
        // Use setCurrentPageAsync for dynamic-page documentAccess
        await figma.setCurrentPageAsync(page);
        figma.viewport.scrollAndZoomIntoView([node]);
        figma.currentPage.selection = [node];
        figma.notify(`Selected: ${node.name || 'object'}`);
        return;
      }
    }
  }
  
  figma.notify('Object not found. It may have been deleted.');
}

// Initialize: scan file and refresh UI
async function initialize() {
  await scanAllHyperlinks();
  await refreshLinksList();
  validateSelection();
}

// Check initial selection and initialize
initialize();

// Listen for selection changes
figma.on('selectionchange', () => {
  validateSelection();
});

// Handle messages from the UI
figma.ui.onmessage = async (msg) => {
  if (msg.type === 'validate-object-selection') {
    validateSelection();
  } else if (msg.type === 'add-link') {
    await addHyperlink(msg.url);
  } else if (msg.type === 'refresh-links') {
    await scanAllHyperlinks();
    await refreshLinksList();
  } else if (msg.type === 'select-node') {
    await selectNodeById(msg.nodeId);
  } else if (msg.type === 'delete-link') {
    await deleteLink(msg.nodeId);
  }
};

// Find the original node ID when a Group or Link Object is selected
function findOriginalNodeId(node, links) {
  // Check if this node is a group that contains our hyperlink text node
  if (node.type === 'GROUP' && 'children' in node) {
    // Find the text node and original node in the group
    let textNode = null;
    let originalNode = null;
    
    for (const child of node.children) {
      if (child.type === 'TEXT' && child.opacity === 0) {
        try {
          const fontSize = child.getRangeFontSize(0, 1);
          if (fontSize === 12 && child.characters.length > 0 && child.characters[0] === 'x') {
            textNode = child;
            break;
          }
        } catch (e) {
          // Continue checking
        }
      }
    }
    
    // Find the original node (the one that's not the text node)
    if (textNode) {
      for (const child of node.children) {
        if (child.id !== textNode.id) {
          originalNode = child;
          break;
        }
      }
    }
    
    if (originalNode) {
      return originalNode.id;
    }
  }
  
  // Check if this node is a text node that's part of an AnyLink setup
  if (node.type === 'TEXT' && node.opacity === 0) {
    try {
      const fontSize = node.getRangeFontSize(0, 1);
      if (fontSize === 12 && node.characters.length > 0 && node.characters[0] === 'x') {
        // Check if it's in a group (our AnyLink groups contain both the original node and text node)
        if (node.parent && node.parent.type === 'GROUP') {
          // Find the original node (the one that's not this text node)
          for (const sibling of node.parent.children) {
            if (sibling.id !== node.id) {
              return sibling.id;
            }
          }
        }
      }
    } catch (e) {
      // Not our text node
    }
  }
  
  // Check if this node ID matches any groupId or textNodeId in stored links
  for (const [nodeId, linkData] of Object.entries(links)) {
    if (linkData.groupId === node.id || linkData.textNodeId === node.id) {
      return nodeId; // Return the original node ID
    }
  }
  
  return null;
}

// Check if a node is a Group or Link Object created by AnyLink
function isAnyLinkGroupOrTextNode(node, links) {
  return findOriginalNodeId(node, links) !== null;
}

async function validateSelection() {
  const selection = figma.currentPage.selection;
  let links = await loadLinksFromStorage();
  
  const selectionInfo = await Promise.all(selection.map(async node => {
    const existingLink = findExistingHyperlink(node);
    let existingUrl = null;
    
    if (existingLink) {
      // Try to get the hyperlink URL from the text node
      existingUrl = getUrlFromTextNode(existingLink);
      
      // If link found but not in storage, add it
      // Check both by node.id and by checking if the file hash matches
      const currentFileHash = getFileHash();
      const linkExists = links[node.id] && links[node.id].fileId === currentFileHash;
      
      if (existingUrl && !linkExists) {
        const groupId = existingLink.parent && existingLink.parent.type === 'GROUP' 
          ? existingLink.parent.id 
          : null;
        await saveLinkToStorage(node.id, node.name || 'Unnamed', existingLink.id, groupId, existingUrl);
        // Reload links after saving to get updated data
        links = await loadLinksFromStorage();
        // Explicitly refresh the links list to ensure UI updates
        await refreshLinksList();
      }
    }
    
    // Check if this is a Group or Link Object - if so, find the original node
    const originalNodeId = findOriginalNodeId(node, links);
    const isGroupOrLinkObject = originalNodeId !== null;
    
    // If it's a Group or Link Object, get the URL from the original node's link
    let groupOrLinkObjectUrl = null;
    if (isGroupOrLinkObject && originalNodeId && links[originalNodeId]) {
      groupOrLinkObjectUrl = links[originalNodeId].url;
    }
    
    return {
      id: node.id,
      type: node.type,
      hasHyperlink: existingLink !== null || isGroupOrLinkObject,
      hyperlinkUrl: existingUrl || groupOrLinkObjectUrl,
      isGroupOrLinkObject: isGroupOrLinkObject,
      originalNodeId: originalNodeId
    };
  }));
  
  figma.ui.postMessage({
    type: 'selection-update',
    selection: selectionInfo
  });
}

async function addHyperlink(url) {
  try {
    const selection = figma.currentPage.selection;
    const links = await loadLinksFromStorage();
    
    if (selection.length === 0) {
      figma.notify('Please select an object to add a hyperlink');
      return;
    }

    // Handle Group or Link Object selections - find original nodes to update
    const nodesToUpdate = [];
    for (const node of selection) {
      const originalNodeId = findOriginalNodeId(node, links);
      if (originalNodeId) {
        // Find the original node by ID
        function findNodeById(currentNode, targetId) {
          if (currentNode.id === targetId) {
            return currentNode;
          }
          if ('children' in currentNode) {
            for (const child of currentNode.children) {
              const found = findNodeById(child, targetId);
              if (found) return found;
            }
          }
          return null;
        }
        
        // Search for the original node
        for (const page of figma.root.children) {
          if (page.type === 'PAGE') {
            const originalNode = findNodeById(page, originalNodeId);
            if (originalNode) {
              nodesToUpdate.push(originalNode);
              break;
            }
          }
        }
      } else {
        nodesToUpdate.push(node);
      }
    }

    // Validate and process URL
    if (!url || typeof url !== 'string') {
      figma.notify('Please enter a valid URL');
      return;
    }

    // Ensure URL has protocol
    let hyperlinkUrl = url.trim();
    if (hyperlinkUrl.length === 0) {
      figma.notify('Please enter a valid URL');
      return;
    }
    if (!hyperlinkUrl.match(/^https?:\/\//i)) {
      hyperlinkUrl = 'https://' + hyperlinkUrl;
    }

    for (const node of nodesToUpdate) {
      try {
        // Check if node already has a hyperlink (by checking for hidden text child)
        const existingLink = findExistingHyperlink(node);
        
        if (existingLink) {
          // Update existing hyperlink
          await updateHyperlink(existingLink, hyperlinkUrl);
          // Find the group (parent of both node and textNode)
          const groupId = existingLink.parent && existingLink.parent.type === 'GROUP' 
            ? existingLink.parent.id 
            : null;
          // Update in storage
          await saveLinkToStorage(node.id, node.name || 'Unnamed', existingLink.id, groupId, hyperlinkUrl);
          figma.notify(`Updated hyperlink for ${node.name || 'object'}`);
        } else {
          // Create new hyperlink
          const result = await createHyperlink(node, hyperlinkUrl);
          // Save to storage
          await saveLinkToStorage(node.id, node.name || 'Unnamed', result.textNode.id, result.group.id, hyperlinkUrl);
          figma.notify(`Added hyperlink to ${node.name || 'object'}`);
        }
      } catch (error) {
        figma.notify(`Error adding hyperlink to ${node.name || 'object'}: ${error.message}`);
        console.error('Error in addHyperlink:', error);
      }
    }
  } catch (error) {
    figma.notify(`Error: ${error.message}`);
    console.error('Fatal error in addHyperlink:', error);
  }
}

// Helper function to extract and load font from error messages
async function loadFontFromError(error, fallbackFont) {
  if (!error || !error.message || !error.message.includes('unloaded font')) {
    return fallbackFont;
  }
  
  // Try multiple regex patterns to extract font name from error message
  // Error formats:
  // "in set_characters: Cannot write to node with unloaded font \"Inter Medium\""
  // "Cannot write to node with unloaded font \"Inter Regular\""
  let fontMatch = error.message.match(/\\"([^"]+)\\"/);
  
  // If that doesn't work, try without escaped quotes
  if (!fontMatch) {
    fontMatch = error.message.match(/"([^"]+)"/);
  }
  
  // If that doesn't work, try matching after "unloaded font"
  if (!fontMatch) {
    fontMatch = error.message.match(/unloaded font[^"]*"([^"]+)"/);
  }
  
  if (fontMatch) {
    const fontName = fontMatch[1]; // e.g., "Inter Medium" or "Inter Regular"
    const parts = fontName.split(' ');
    if (parts.length >= 2) {
      const family = parts[0]; // "Inter"
      const style = parts.slice(1).join(' '); // "Medium" or "Regular"
      try {
        const font = { family: family, style: style };
        await figma.loadFontAsync(font);
        return font;
      } catch (loadError) {
        // If loading fails, return fallback
        return fallbackFont;
      }
    }
  }
  return fallbackFont;
}

// Helper function to safely set text properties with automatic font loading
async function setTextPropertySafely(textNode, property, value, loadedFont) {
  let attempts = 0;
  const maxAttempts = 3;
  
  while (attempts < maxAttempts) {
    try {
      textNode[property] = value;
      return; // Success!
    } catch (error) {
      attempts++;
      
      // If it fails due to unloaded font, try to load the font from the error
      if (error.message && error.message.includes('unloaded font')) {
        const font = await loadFontFromError(error, loadedFont);
        
        // Load the font
        try {
          await figma.loadFontAsync(font);
        } catch (loadError) {
          // If loading the extracted font fails, try the fallback
          if (font !== loadedFont) {
            try {
              await figma.loadFontAsync(loadedFont);
            } catch (fallbackError) {
              // If both fail, throw the original error
              if (attempts >= maxAttempts) {
                throw error;
              }
              continue;
            }
          } else {
            // If both fail, throw the original error
            if (attempts >= maxAttempts) {
              throw error;
            }
            continue;
          }
        }
        
        // Retry setting the property
        continue;
      } else {
        // Not a font loading error, throw it
        throw error;
      }
    }
  }
}

function findExistingHyperlink(node) {
  // Look for a hidden text node sibling that might be the hyperlink
  // Now that we group nodes, they'll be siblings in the same parent (frame)
  if (node.parent && 'children' in node.parent) {
    const parent = node.parent;
    const nodeIndex = parent.children.indexOf(node);
    
    // Check all siblings (both before and after, since they're now grouped)
    for (let i = 0; i < parent.children.length; i++) {
      if (i === nodeIndex) continue; // Skip the node itself
      const sibling = parent.children[i];
      if (sibling.type === 'TEXT' && sibling.opacity === 0) {
        // Check if it's our hidden hyperlink text (font size 12, filled with 'x')
        try {
          const fontSize = sibling.getRangeFontSize(0, 1);
          if (fontSize === 12) {
            // When grouped, both nodes are at (0,0) relative to the frame
            // So we check if they're at the same relative position
            const posMatch = Math.abs(sibling.x - node.x) < 1 && Math.abs(sibling.y - node.y) < 1;
            const sizeMatch = 'width' in node && 'height' in node && 
                              Math.abs(sibling.width - node.width) < 1 && 
                              Math.abs(sibling.height - node.height) < 1;
            if (posMatch && sizeMatch && sibling.characters.length > 0 && sibling.characters[0] === 'x') {
              return sibling;
            }
          }
        } catch (e) {
          // Continue searching if we can't read the font size
        }
      }
    }
  }
  return null;
}

async function createHyperlink(node, url) {
  let textNode = null;
  try {
    // Get the node's dimensions and position
    const width = 'width' in node ? node.width : 100;
    const height = 'height' in node ? node.height : 100;
    const x = node.x;
    const y = node.y;
    
    // Validate dimensions
    if (!isFinite(width) || !isFinite(height) || width <= 0 || height <= 0) {
      throw new Error('Invalid object dimensions');
    }

    // Load font first (required before setting fontSize)
    // Try multiple fonts and styles in order of preference, falling back to common fonts
    // Figma often defaults to "Inter Regular" or "Inter Medium", so try those first
    let loadedFont = null;
    
    // First, try to load common default fonts that Figma might use
    const commonDefaults = [
      { family: "Inter", style: "Regular" },
      { family: "Inter", style: "Medium" },
      { family: "Inter", style: "Normal" }
    ];
    
    for (const font of commonDefaults) {
      try {
        await figma.loadFontAsync(font);
        loadedFont = font;
        break;
      } catch (error) {
        continue;
      }
    }
    
    // If common defaults didn't work, try other fonts
    if (!loadedFont) {
      const fontFamilies = ["Inter", "Roboto", "Arial", "Helvetica", "Times New Roman", "Courier New"];
      const fontStyles = ["Regular", "Medium", "Normal", "Bold", "Light", "Italic"];
      
      for (const family of fontFamilies) {
        for (const style of fontStyles) {
          try {
            const font = { family: family, style: style };
            await figma.loadFontAsync(font);
            loadedFont = font;
            break;
          } catch (error) {
            continue;
          }
        }
        if (loadedFont) {
          break;
        }
      }
    }
    
    if (!loadedFont) {
      throw new Error('Could not load any available font');
    }
    
    // Create a text node
    textNode = figma.createText();
    textNode.opacity = 0; // Make it invisible
    
    // Reload font right before using it to ensure it's available
    await figma.loadFontAsync(loadedFont);
    
    // Set characters first - this will establish the font
    // Use our helper function to handle any font loading errors dynamically
    await setTextPropertySafely(textNode, 'characters', 'x', loadedFont);
    
    // Now set fontSize - use helper to handle font loading if needed
    await setTextPropertySafely(textNode, 'fontSize', 12, loadedFont);
    
    // Set the font explicitly to ensure it uses our loaded font
    await figma.loadFontAsync(loadedFont);
    try {
      textNode.setRangeFontName(0, 1, loadedFont);
    } catch (error) {
      // If setting font name fails, try to load the font from error and retry
      const font = await loadFontFromError(error, loadedFont);
      await figma.loadFontAsync(font);
      try {
        textNode.setRangeFontName(0, 1, font);
      } catch (retryError) {
        // If it still fails, that's okay - the font should already be set from characters
      }
    }
    
    // Now set auto-resize after font is established
    textNode.textAutoResize = 'WIDTH_AND_HEIGHT';
    textNode.x = x;
    textNode.y = y;
    
    // Add to page temporarily to measure dimensions
    if (node.parent && 'children' in node.parent) {
      node.parent.appendChild(textNode);
    } else {
      figma.currentPage.appendChild(textNode);
    }
    
    // Measure the actual width and height of a single 'x' character
    const charWidth = textNode.width;
    const charHeight = textNode.height;
    
    // Safety check: prevent creating too many characters (limit to reasonable size)
    // Maximum total characters to prevent freezing (100k should be safe)
    const MAX_TOTAL_CHARS = 100000;
    const MAX_CHARS_PER_LINE = 5000;
    const MAX_LINES = 5000;
    
    // Now switch to manual sizing
    textNode.textAutoResize = 'NONE';
    
    // Calculate how many characters we need to fill the width and height
    // Add extra padding to ensure full coverage, especially for the right edge
    // Use different multipliers for horizontal and vertical to avoid over-extending
    const horizontalPaddingMultiplier = 1.5; // Add 50% extra for width (top, left, right edges)
    const verticalPaddingMultiplier = 0.5; // Use 50% of height to prevent over-extending
    let charsPerLine = Math.ceil((width / charWidth) * horizontalPaddingMultiplier) + 10;
    let numLines = Math.ceil((height / charHeight) * verticalPaddingMultiplier); // Reduced to prevent bottom overflow
    
    // Cap the values to prevent freezing
    const totalChars = charsPerLine * numLines;
    if (totalChars > MAX_TOTAL_CHARS) {
      // Scale down proportionally to stay within limit
      const scale = Math.sqrt(MAX_TOTAL_CHARS / totalChars);
      charsPerLine = Math.floor(charsPerLine * scale);
      numLines = Math.floor(numLines * scale);
    }
    
    if (charsPerLine > MAX_CHARS_PER_LINE) {
      charsPerLine = MAX_CHARS_PER_LINE;
    }
    if (numLines > MAX_LINES) {
      numLines = MAX_LINES;
    }
    
    // Fill the text with 'x' characters to completely fill the box
    // Reload font before setting characters to ensure it's available
    await figma.loadFontAsync(loadedFont);
    
    // Create lines of 'x' characters separated by newlines
    // Use a more efficient approach for large text
    try {
      const lines = [];
      for (let i = 0; i < numLines; i++) {
        lines.push('x'.repeat(charsPerLine));
      }
      const fullText = lines.join('\n');
      // Use helper function to handle any font loading errors
      await setTextPropertySafely(textNode, 'characters', fullText, loadedFont);
    } catch (error) {
      // If creating the text fails, fall back to a minimal approach
      // Use helper function to handle font loading
      const fallbackChars = Math.min(charsPerLine * numLines, 50000);
      await setTextPropertySafely(textNode, 'characters', 'x'.repeat(fallbackChars), loadedFont);
      figma.notify('Large object detected - using optimized hyperlink');
    }
    
    // Resize to match the node dimensions exactly
    textNode.resize(width, height);
    
    // Ensure exact position match
    textNode.x = x;
    textNode.y = y;

    // Set the hyperlink
    // In Figma API, hyperlinks are set using setRangeHyperlink for text ranges
    const textLength = textNode.characters.length;
    if (textLength > 0) {
      textNode.setRangeHyperlink(0, textLength, { type: 'URL', value: url });
    }

    // Group the text node with the original object so they move together
    // Use figma.group() which automatically maintains absolute positions
    const originalParent = node.parent;
    const originalIndex = originalParent && 'children' in originalParent 
      ? originalParent.children.indexOf(node) 
      : undefined;
    
    // Group both nodes together - figma.group() maintains their absolute positions
    const group = figma.group([node, textNode], originalParent || figma.currentPage, originalIndex);
    group.name = node.name + ' (with hyperlink)';
    
    // Return both text node and group so we can save their IDs to storage
    return { textNode: textNode, group: group };
  } catch (error) {
    // Clean up text node if something went wrong
    if (textNode && textNode.parent) {
      try {
        textNode.remove();
      } catch (cleanupError) {
        // Ignore cleanup errors
      }
    }
    throw error;
  }
}

async function updateHyperlink(textNode, url) {
  // Update hyperlink using setRangeHyperlink
  const textLength = textNode.characters.length;
  if (textLength > 0) {
    textNode.setRangeHyperlink(0, textLength, { type: 'URL', value: url });
  }
}


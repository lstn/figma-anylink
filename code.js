// This plugin allows adding hyperlinks to any Figma object by creating
// a hidden text node behind the object with the hyperlink

figma.showUI(__html__, { width: 300, height: 200 });

// Check initial selection
validateSelection();

// Listen for selection changes
figma.on('selectionchange', () => {
  validateSelection();
});

// Handle messages from the UI
figma.ui.onmessage = (msg) => {
  if (msg.type === 'validate-object-selection') {
    validateSelection();
  } else if (msg.type === 'add-link') {
    addHyperlink(msg.url);
  }
};

function validateSelection() {
  const selection = figma.currentPage.selection;
  figma.ui.postMessage({
    type: 'selection-update',
    selection: selection.map(node => ({ id: node.id, type: node.type }))
  });
}

async function addHyperlink(url) {
  try {
    const selection = figma.currentPage.selection;
    
    if (selection.length === 0) {
      figma.notify('Please select an object to add a hyperlink');
      return;
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

    for (const node of selection) {
      try {
        // Check if node already has a hyperlink (by checking for hidden text child)
        const existingLink = findExistingHyperlink(node);
        
        if (existingLink) {
          // Update existing hyperlink
          await updateHyperlink(existingLink, hyperlinkUrl);
          figma.notify(`Updated hyperlink for ${node.name || 'object'}`);
        } else {
          // Create new hyperlink
          await createHyperlink(node, hyperlinkUrl);
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


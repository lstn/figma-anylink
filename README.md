# AnyLink

A Figma plugin that allows you to add hyperlinks to any Figma object, not just text elements.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Compile TypeScript to JavaScript:
   ```bash
   npm run build
   ```

3. Open Figma and go to **Plugins > Development > Import plugin from manifest...**

4. Select the `manifest.json` file from this directory

## Usage

1. Select any object in Figma (frame, rectangle, group, etc.)
2. Run the "AnyLink" plugin
3. Enter the URL you want to link to
4. Click "Add Link"
5. The object is now clickable with your hyperlink!

## Features

- Add hyperlinks to any Figma object (not just text)
- Update existing hyperlinks by selecting the object again
- Automatically adds "https://" if no protocol is specified
- Works with multiple selected objects


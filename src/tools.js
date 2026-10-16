// Tool definitions (MCP schemas). Names and `computer` actions mirror Claude in Chrome.
const tabId = { type: 'number', description: 'Tab ID. Defaults to the current AI tab, else the active tab.' };
const coordinate = { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: '[x, y] in screenshot pixels' };

export const TOOLS = [
  {
    name: 'tabs_context',
    description: 'List open tabs with their IDs, titles and URLs. Shows which tab is current/active and which are in the AI tab group.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'tabs_create',
    description: 'Open a new tab (added to the "AI" tab group) and make it the current tab.',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'URL to open (optional)' } } },
  },
  {
    name: 'tabs_select',
    description: 'Activate a tab and make it the current tab for later commands.',
    inputSchema: { type: 'object', properties: { tabId }, required: ['tabId'] },
  },
  {
    name: 'tabs_close',
    description: 'Close a tab.',
    inputSchema: { type: 'object', properties: { tabId }, required: ['tabId'] },
  },
  {
    name: 'navigate',
    description: 'Navigate a tab to a URL and wait for it to load. Use "back", "forward" or "reload" for history.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, tabId }, required: ['url'] },
  },
  {
    name: 'computer',
    description:
      'Use mouse and keyboard on a tab and take screenshots. Actions: screenshot, left_click, right_click, double_click, ' +
      'triple_click, hover, left_click_drag, type, key, scroll, scroll_to, wait, zoom. Coordinates are pixels in the ' +
      'latest screenshot; alternatively pass a ref from read_page/find. Take a screenshot first to see the page.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['screenshot', 'left_click', 'right_click', 'double_click', 'triple_click', 'hover', 'left_click_drag',
            'type', 'key', 'scroll', 'scroll_to', 'wait', 'zoom'],
        },
        coordinate,
        start_coordinate: { ...coordinate, description: 'Drag start [x, y] (left_click_drag)' },
        ref: { type: 'string', description: 'Element ref (e.g. ref_12) from read_page/find, instead of coordinate' },
        text: { type: 'string', description: 'Text to type, or keys for "key" (e.g. "Enter", "cmd+a", "Tab Tab Enter")' },
        modifiers: { type: 'string', description: 'Modifier keys held during a click, e.g. "shift" or "cmd+shift"' },
        repeat: { type: 'number', description: 'Times to repeat the key sequence (key)' },
        scroll_direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        scroll_amount: { type: 'number', description: 'Scroll ticks (100px each), default 3' },
        duration: { type: 'number', description: 'Seconds to wait (wait), max 30' },
        region: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4, description: '[x0, y0, x1, y1] to zoom into' },
        tabId,
      },
      required: ['action'],
    },
  },
  {
    name: 'read_page',
    description: 'Accessibility-tree snapshot of the page with element refs (ref_N) usable in computer/form_input. filter "interactive" lists only controls.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', enum: ['all', 'interactive'] },
        depth: { type: 'number', description: 'Max tree depth (default 15)' },
        ref_id: { type: 'string', description: 'Only return the subtree under this ref' },
        tabId,
      },
    },
  },
  {
    name: 'find',
    description: 'Find elements whose role/name/attributes match the query words. Returns matching lines with refs.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, tabId }, required: ['query'] },
  },
  {
    name: 'form_input',
    description: 'Set a form field value by ref: text inputs, textareas, selects (by value or label), checkboxes/radios (true/false).',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string' }, value: { type: ['string', 'number', 'boolean'] }, tabId },
      required: ['ref', 'value'],
    },
  },
  {
    name: 'get_page_text',
    description: 'Get the readable text of the page (article/main/body).',
    inputSchema: { type: 'object', properties: { max_chars: { type: 'number' }, tabId } },
  },
  {
    name: 'javascript_tool',
    description: 'Evaluate JavaScript in the page (main world) and return the result. Top-level await is supported.',
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'JavaScript code' }, tabId }, required: ['text'] },
  },
  {
    name: 'read_console_messages',
    description: 'Read console messages, exceptions and auto-accepted dialogs captured since AI in Chrome attached to the tab.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex filter' },
        onlyErrors: { type: 'boolean' },
        limit: { type: 'number' },
        clear: { type: 'boolean' },
        tabId,
      },
    },
  },
  {
    name: 'read_network_requests',
    description: 'Read network requests captured since AI in Chrome attached to the tab.',
    inputSchema: {
      type: 'object',
      properties: { urlPattern: { type: 'string', description: 'Substring filter' }, limit: { type: 'number' }, clear: { type: 'boolean' }, tabId },
    },
  },
  {
    name: 'resize_window',
    description: "Resize the tab's browser window.",
    inputSchema: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' }, tabId }, required: ['width', 'height'] },
  },
  {
    name: 'cdp_command',
    description: 'Send a raw Chrome DevTools Protocol command to a tab (escape hatch), e.g. method "Page.reload".',
    inputSchema: { type: 'object', properties: { method: { type: 'string' }, params: { type: 'object' }, tabId }, required: ['method'] },
  },
  {
    name: 'extension_reload',
    description: 'Reload the AI in Chrome extension so it picks up code changes from disk.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'gif_creator',
    description:
      'Record browser actions as an animated GIF with click markers, drag paths, action labels, progress bar and watermark. ' +
      'Actions: start_recording (then take a screenshot for the first frame), stop_recording (take a screenshot just before), ' +
      'export (saves the GIF to save_path, default ~/Downloads; or download:true for Chrome downloads; or coordinate to drop it on the page), clear.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start_recording', 'stop_recording', 'export', 'clear'] },
        save_path: { type: 'string', description: 'export: file or folder to save the GIF to (default ~/Downloads)' },
        download: { type: 'boolean', description: "export: save via Chrome's downloads instead" },
        coordinate: { ...coordinate, description: 'export: drop the GIF onto the page at [x, y] (screenshot pixels)' },
        filename: { type: 'string' },
        options: {
          type: 'object',
          description: 'showClickIndicators, showDragPaths, showActionLabels, showProgressBar, showWatermark (default true), quality (1-30, lower = better, default 10)',
        },
        tabId,
      },
      required: ['action'],
    },
  },
  {
    name: 'file_upload',
    description:
      'Upload local files into an <input type="file"> by ref (find it with read_page/find; it is often hidden). ' +
      'Do not click upload buttons: that opens a native file picker you cannot control. Max 10 MB total.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'ref of the file input' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Local file paths to upload' },
        files: {
          type: 'array',
          description: 'Alternatively, file contents: [{ name, data (base64), mimeType }]',
          items: { type: 'object', properties: { name: { type: 'string' }, data: { type: 'string' }, mimeType: { type: 'string' } }, required: ['name', 'data'] },
        },
        tabId,
      },
      required: ['ref'],
    },
  },
  {
    name: 'upload_image',
    description:
      'Upload an image to a file input (ref) or drop it onto a drop zone (coordinate, e.g. Google Docs). ' +
      'The image is a screenshot by its image ID (shown in the screenshot result) or a local file path.',
    inputSchema: {
      type: 'object',
      properties: {
        imageId: { type: 'string', description: 'Screenshot image ID, e.g. shot_3' },
        path: { type: 'string', description: 'Local image file instead of a screenshot' },
        ref: { type: 'string' },
        coordinate,
        filename: { type: 'string' },
        tabId,
      },
    },
  },
];

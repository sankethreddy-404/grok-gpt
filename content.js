// Configuration
const CONFIG = {
  maxRetries: 3,
  retryDelay: 1000,
  responseCheckInterval: 1000,
  responseTimeout: 30000,
  networkCheckInterval: 5000,
  selectorDiscoveryTimeout: 10000,
  mutationObserverConfig: {
    childList: true,
    subtree: true,
    characterData: true,
  },
};

// State tracking
let lastResponse = "";
let isWaitingForResponse = false;
let responseCheckTimeout = null;
let networkCheckInterval = null;
let isOnline = navigator.onLine;

// Network status monitoring
window.addEventListener("online", () => {
  isOnline = true;
  chrome.runtime.sendMessage({
    action: "connectionStatus",
    status: "online",
  });
});

window.addEventListener("offline", () => {
  isOnline = false;
  chrome.runtime.sendMessage({
    action: "connectionStatus",
    status: "offline",
  });
});

// Enhanced selectors with fallbacks
const SELECTORS = {
  inputField: [
    'textarea[placeholder*="message" i]',
    'textarea[aria-label*="chat" i]',
    "textarea",
    'input[type="text"]',
  ],
  sendButton: [
    'button[type="submit"]',
    'button[aria-label*="send" i]',
    "button:has(svg)",
    "button.send-button",
    'button[data-testid="send-button"]',
  ],
  responseArea: [
    ".response-area",
    ".message-bubble",
    ".chat-message",
    ".text-token-text-primary",
  ],
  loadingIndicator: [
    ".typing-indicator",
    ".loading",
    ".spinner",
    '[role="progressbar"]',
  ],
};

// Helper function to try multiple selectors
function findElement(selectors) {
  for (const selector of selectors) {
    const element = document.querySelector(selector);
    if (element) return element;
  }
  return null;
}

// Retry mechanism with exponential backoff
async function retry(operation, retryCount = 0) {
  try {
    return await operation();
  } catch (error) {
    if (retryCount >= CONFIG.maxRetries) throw error;

    const delay = CONFIG.retryDelay * Math.pow(2, retryCount);
    await new Promise((resolve) => setTimeout(resolve, delay));
    return retry(operation, retryCount + 1);
  }
}

// Dynamic selector discovery
async function discoverSelectors() {
  const commonPatterns = {
    input: [
      "textarea",
      'input[type="text"]',
      '[contenteditable="true"]',
      '[role="textbox"]',
    ],
    button: ["button", '[role="button"]', 'a[href="#"]'],
    response: ['[role="log"]', ".response", ".message", ".chat-content"],
  };

  // Wait for elements to be available
  const startTime = Date.now();
  while (Date.now() - startTime < CONFIG.selectorDiscoveryTimeout) {
    for (const type in commonPatterns) {
      for (const pattern of commonPatterns[type]) {
        const elements = document.querySelectorAll(pattern);
        for (const element of elements) {
          // Check if element is visible
          const style = window.getComputedStyle(element);
          if (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            element.offsetWidth > 0
          ) {
            // Store discovered selector
            SELECTORS[type].unshift(pattern);
            break;
          }
        }
      }
    }

    // If we found at least one of each type, break
    if (
      findElement(SELECTORS.inputField) &&
      findElement(SELECTORS.sendButton) &&
      findElement(SELECTORS.responseArea)
    ) {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

// Set up mutation observer for dynamic content
let responseObserver = null;
function setupResponseObserver() {
  if (responseObserver) {
    responseObserver.disconnect();
  }

  const targetNode = document.body;
  responseObserver = new MutationObserver((mutations) => {
    if (isWaitingForResponse) {
      for (const mutation of mutations) {
        if (
          mutation.type === "childList" ||
          mutation.type === "characterData"
        ) {
          const responseElement = findElement(SELECTORS.responseArea);
          if (
            responseElement &&
            responseElement.textContent.trim() !== lastResponse
          ) {
            // Check if response is complete
            const loadingIndicator = findElement(SELECTORS.loadingIndicator);
            if (!loadingIndicator) {
              const newResponse = responseElement.textContent.trim();
              lastResponse = newResponse;
              isWaitingForResponse = false;

              chrome.runtime.sendMessage({
                action: "responseReceived",
                response: newResponse,
              });
            }
          }
        }
      }
    }
  });

  responseObserver.observe(targetNode, CONFIG.mutationObserverConfig);
}

// Enhanced initialization
async function initialize() {
  await discoverSelectors();
  setupResponseObserver();
}

// Start initialization when script loads
initialize().catch((error) => {
  console.error("Initialization error:", error);
  chrome.runtime.sendMessage({
    action: "initError",
    error: error.message,
  });
});

// Enhanced message sending with validation
async function sendMessage(message) {
  if (!isOnline) {
    throw new Error("Network connection unavailable");
  }

  try {
    await retry(async () => {
      let input = findElement(SELECTORS.inputField);
      let sendButton = findElement(SELECTORS.sendButton);

      // If elements not found, try discovering them again
      if (!input || !sendButton) {
        await discoverSelectors();
        input = findElement(SELECTORS.inputField);
        sendButton = findElement(SELECTORS.sendButton);

        if (!input || !sendButton) {
          throw new Error("Chat interface elements not found");
        }
      }

      // Clear existing text
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Set new message
      input.value = message;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Validate message was set
      if (input.value !== message) {
        throw new Error("Failed to set message text");
      }

      sendButton.click();
      isWaitingForResponse = true;
      waitForResponse();
    });
  } catch (error) {
    console.error("Failed to send message:", error);
    chrome.runtime.sendMessage({
      action: "sendError",
      error: error.message,
    });
  }
}

// Update waitForResponse to use mutation observer
function waitForResponse() {
  let startTime = Date.now();

  if (responseCheckTimeout) {
    clearTimeout(responseCheckTimeout);
  }

  // Set timeout for response
  responseCheckTimeout = setTimeout(() => {
    if (isWaitingForResponse) {
      chrome.runtime.sendMessage({
        action: "responseError",
        error: "No response received",
      });
      isWaitingForResponse = false;
    }
  }, CONFIG.responseTimeout);
}

// Message listener
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "sendMessage") {
    sendMessage(message.message);
  }
});

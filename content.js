// --- content.js ---
const CONFIG = {
  responseTimeout: 60000, // Increased to 60 seconds
  responseStabilityTime: 1500, // 1.5 seconds - Wait for stability
  mutationObserverConfig: {
    childList: true,
    subtree: true,
    characterData: true,
  },
  debug: true, // Enable debug logging
  forceSendResponsesAfter: 10000, // Force send responses after 10 seconds even if they're still changing
};

let lastResponse = "";
let isWaitingForResponse = false;
let responseCheckTimeout = null;
let stabilityTimeout = null; // For response stability
let lastProcessedResponse = null; // Track last processed response to avoid duplicates
let responseSequenceId = 0; // Add sequence ID to help with response tracking
let forceResponseTimeout = null; // Timeout to force sending a response

// Log function for debugging
function debugLog(...args) {
  if (CONFIG.debug) {
    console.log("[Grok-GPT Debug]", ...args);
  }
}

// Identify which chat platform we're on
const isGrok =
  window.location.hostname.includes("grok") ||
  window.location.hostname.includes("x.ai");
const isChatGPT = window.location.hostname.includes("chat.openai.com");

debugLog(
  "Page identified as:",
  isGrok ? "Grok" : isChatGPT ? "ChatGPT" : "Unknown"
);
debugLog("Current URL:", window.location.href);

// Platform-specific selectors
const SELECTORS = {
  inputField: [
    // ChatGPT selectors
    'textarea[data-testid="textbox"]',
    'textarea[placeholder="Send a message"]',
    'textarea[placeholder*="Send a message"]',
    "textarea.TextareaAutosize",

    // Grok selectors - more comprehensive
    "div.message-bubble.px-4.py-2\\.5.rounded-br-lg > span > p.break-words",
    'div.relative div[contenteditable="true"]',
    'div[contenteditable="true"]',
    'div[role="textbox"]',
    "div.overflow-hidden.max-h-\\[200px\\] textarea",

    // Generic fallbacks
    "textarea",
    'input[type="text"]',
  ],

  sendButton: [
    // ChatGPT selectors
    'button[type="submit"]',
    'button:has(svg[data-testid="send-button"])',
    'button[data-testid="send-button"]',
    'button[aria-label*="Send"]',

    // Grok selectors
    'button:has(svg[width="24"])',
    'button[aria-label="Send message"]',
    "button.btn-primary",
    'button[type="submit"]',
    "button.svelte-1ltuiacc", // Possible Grok send button class
  ],

  responseArea: [
    // ChatGPT selectors - specific first
    'div[data-message-author-role="assistant"]',
    'div[data-message-author-role="assistant"] div.prose',
    'article[data-testid^="conversation-turn-"] .agent-turn',
    ".markdown.prose",
    "div.text-message",
    ".group/conversation-turn",
    ".agent-turn",
    ".result-streaming",
    "main div.flex.flex-col.text-sm",

    // Grok selectors - expanded
    'div[dir="auto"].message-bubble',
    "div.w-full div.text-token-text-primary",
    'div.message-bubble div[dir="auto"]',
    "div.text-token-text-primary",
    "div.whitespace-pre-wrap.break-words",
    'div[data-message-author-role="assistant"]',
    ".gizmo-shadow-stroke",
    "div.prose",
    "div.whitespace-pre-wrap",

    // Generic fallbacks
    ".response-area",
    ".message-bubble",
    ".chat-message",
    ".response-container",
  ],

  loadingIndicator: [
    // ChatGPT
    ".result-streaming",
    ".typing-indicator",
    ".loading",
    ".spinner",
    '[role="progressbar"]',
    'div[data-state="loading"]',
    "div.animate-pulse",
    'div.grid.gap-2[data-state="loading"]',

    // Grok
    ".thinking",
    "div.animate-bounce",
    "div.animate-pulse",
    "span.v-mid.inline-flex.gap-1", // Possibly grok's typing indicator
  ],

  // All message containers to find the latest response
  messageContainers: [
    // Grok message containers
    "div.flex.flex-col.gap-1",
    "div.flex.flex-col > div.flex.items-start",
    "div.w-full div.message-bubble",
    'div[role="region"] > div > div',
    // ChatGPT message containers
    'div[role="presentation"] div.group',
    'article[data-testid^="conversation-turn-"]',
    "div.request-response-container", // Generic container
  ],
};

// --- Helper Functions ---
function findElement(selectors) {
  for (const selector of selectors) {
    try {
      const element = document.querySelector(selector);
      if (element) {
        debugLog("Found element with selector:", selector);
        return element;
      }
    } catch (error) {
      debugLog("Error with selector:", selector, error);
    }
  }
  debugLog("No element found for selectors");
  return null;
}

function findElements(selectors) {
  for (const selector of selectors) {
    try {
      const elements = document.querySelectorAll(selector);
      if (elements && elements.length > 0) {
        debugLog(`Found ${elements.length} elements with selector:`, selector);
        return Array.from(elements);
      }
    } catch (error) {
      debugLog("Error with selector:", selector, error);
    }
  }
  return [];
}

function logElementDetails(element, name) {
  if (!element) return;
  debugLog(`${name} details:`, {
    tagName: element.tagName,
    className: element.className,
    id: element.id,
    textContent:
      element.textContent?.substring(0, 50) +
      (element.textContent?.length > 50 ? "..." : ""),
  });
}

// Find the most recent response from the AI assistant
function findLatestResponse() {
  debugLog("Looking for latest response...");

  // Direct attempts to find response text
  let responseElement = null;

  if (isChatGPT) {
    // Get all message elements on the page
    const allMessages = document.querySelectorAll(
      "div[data-message-author-role]"
    );

    // Filter to just find assistant messages
    const assistantMessages = Array.from(allMessages).filter(
      (msg) => msg.getAttribute("data-message-author-role") === "assistant"
    );

    if (assistantMessages && assistantMessages.length > 0) {
      // Get the most recent assistant message
      responseElement = assistantMessages[assistantMessages.length - 1];
      debugLog("Found ChatGPT response via assistant role");
      return responseElement;
    }

    // Fallback to looking for prose content
    const proseElements = document.querySelectorAll("div.prose");
    if (proseElements && proseElements.length > 0) {
      responseElement = proseElements[proseElements.length - 1];
      debugLog("Found ChatGPT response via prose class");
      return responseElement;
    }
  } else if (isGrok) {
    // Look for all message bubbles
    const allBubbles = document.querySelectorAll("div.message-bubble");

    // Filter to non-user bubbles (usually these are on the left side for Grok)
    const botBubbles = Array.from(allBubbles).filter(
      (bubble) => !bubble.classList.contains("bg-background-app")
    );

    if (botBubbles && botBubbles.length > 0) {
      responseElement = botBubbles[botBubbles.length - 1];
      debugLog("Found Grok response via filtered message bubbles");
      return responseElement;
    }

    // Secondary approach - look for text-token-text-primary
    const primaryTextElements = document.querySelectorAll(
      "div.text-token-text-primary"
    );
    if (primaryTextElements && primaryTextElements.length > 0) {
      for (let i = primaryTextElements.length - 1; i >= 0; i--) {
        const el = primaryTextElements[i];
        // Check if this isn't a user message
        const messageContainer = el.closest("div.flex");
        if (
          messageContainer &&
          !messageContainer.classList.contains("justify-end")
        ) {
          responseElement = el;
          debugLog("Found Grok response via text-token-text-primary");
          return responseElement;
        }
      }
    }
  }

  // If we still don't have anything, try more general approaches
  if (!responseElement) {
    for (const selector of SELECTORS.responseArea) {
      try {
        const elements = document.querySelectorAll(selector);
        if (elements && elements.length > 0) {
          responseElement = elements[elements.length - 1]; // Get the last one
          debugLog("Found response element with general selector:", selector);
          return responseElement;
        }
      } catch (error) {
        debugLog("Error with response selector:", selector, error);
      }
    }
  }

  // Last fallback - just try to get message containers
  const messageContainers = findElements(SELECTORS.messageContainers);
  if (messageContainers.length > 0) {
    debugLog("Using fallback to last message container");
    return messageContainers[messageContainers.length - 1];
  }

  return null; // No response element found
}

// Check if response is still being generated
function isResponseStillLoading() {
  const loadingIndicator = findElement(SELECTORS.loadingIndicator);
  return !!loadingIndicator;
}

// --- End Helper Functions ---

function setupResponseObserver() {
  // Target selection for observer
  let targetNode;

  if (isGrok) {
    // Grok-specific targets
    targetNode =
      document.querySelector(".w-full.max-w-3xl.flex.flex-col") ||
      document.querySelector(".overflow-y-auto.py-10") ||
      document.querySelector(".flex.flex-col.items-center.w-full") ||
      document.querySelector('div[role="region"]') ||
      document.querySelector("main") ||
      document.body;
  } else if (isChatGPT) {
    // ChatGPT-specific targets
    targetNode =
      document.querySelector('div[role="presentation"]') ||
      document.querySelector(".m-auto.text-base") ||
      document.querySelector("main") ||
      document.body;
  } else {
    // Generic fallback
    targetNode = document.body;
  }

  debugLog("Setting up observer on:", targetNode);

  const observer = new MutationObserver((mutations) => {
    if (isWaitingForResponse) {
      // Try to find the latest response using the helper function
      const responseElement = findLatestResponse();
      const isLoading = isResponseStillLoading();

      if (responseElement && !isLoading) {
        const newResponse = responseElement.textContent.trim();

        // Skip very short responses that are likely not complete
        if (newResponse.length < 5) {
          return;
        }

        debugLog(
          "Detected response:",
          newResponse.substring(0, 50) + (newResponse.length > 50 ? "..." : "")
        );

        // --- Response Stability Check ---
        if (newResponse !== lastResponse) {
          // Response content changed - update and reset stability timer
          lastResponse = newResponse;
          clearTimeout(stabilityTimeout);

          // Start a new stability timer
          stabilityTimeout = setTimeout(() => {
            processStableResponse(responseElement);
          }, CONFIG.responseStabilityTime);

          // Set up a force timeout in case response keeps changing
          if (!forceResponseTimeout) {
            forceResponseTimeout = setTimeout(() => {
              debugLog("Force timeout triggered - sending response anyway");
              if (isWaitingForResponse) {
                processStableResponse(responseElement, true);
              }
            }, CONFIG.forceSendResponsesAfter);
          }
        }
        // If the response hasn't changed, we keep waiting for the stability timeout
      }
    }
  });

  observer.observe(targetNode, CONFIG.mutationObserverConfig);
  debugLog("Observer setup complete");
  return observer;
}

function processStableResponse(responseElement, forced = false) {
  if (!isWaitingForResponse) return; // Already processed

  const finalResponse = responseElement.textContent.trim();

  // Skip very short or empty responses
  if (!finalResponse || finalResponse.length < 5) {
    debugLog("Skipping short or empty response");
    return;
  }

  // Skip if the response hasn't changed and isn't forced
  if (finalResponse !== lastResponse && !forced) {
    debugLog(
      "Response changed during stability period - waiting for stability"
    );
    return;
  }

  debugLog(
    "Processing stable response:",
    finalResponse.substring(0, 50) + (finalResponse.length > 50 ? "..." : ""),
    forced ? "(forced)" : ""
  );

  // Clear all timeouts
  clearTimeout(responseCheckTimeout);
  clearTimeout(stabilityTimeout);
  clearTimeout(forceResponseTimeout);
  forceResponseTimeout = null;

  // Update state
  isWaitingForResponse = false;
  // Don't check against lastProcessedResponse - let each response go through
  // lastProcessedResponse = finalResponse;
  responseSequenceId++;

  // Send the response to background script
  chrome.runtime.sendMessage(
    {
      action: "responseReceived",
      response: finalResponse,
      source: isGrok ? "grok" : "chatgpt",
      url: window.location.href,
      sequenceId: responseSequenceId,
      forced: forced,
    },
    (response) => {
      if (chrome.runtime.lastError) {
        debugLog("Error sending response:", chrome.runtime.lastError);
        // Try again after a short delay if there was an error
        setTimeout(() => {
          if (chrome.runtime && chrome.runtime.sendMessage) {
            chrome.runtime.sendMessage({
              action: "responseReceived",
              response: finalResponse,
              source: isGrok ? "grok" : "chatgpt",
              url: window.location.href,
              sequenceId: responseSequenceId,
              retry: true,
              forced: forced,
            });
          }
        }, 1000);
      } else {
        debugLog("Response sent successfully");
      }
    }
  );
}

let responseObserver = setupResponseObserver();

async function sendMessage(message) {
  try {
    debugLog(
      "Attempting to send message:",
      message.substring(0, 50) + (message.length > 50 ? "..." : "")
    );

    let input = findElement(SELECTORS.inputField);
    let sendButton = findElement(SELECTORS.sendButton);

    logElementDetails(input, "Input field");
    logElementDetails(sendButton, "Send button");

    if (!input || !sendButton) {
      console.error("Chat interface elements not found");
      debugLog(
        "Input field found:",
        !!input,
        "Send button found:",
        !!sendButton
      );

      // Try to find any input elements for debugging purposes
      const allInputs = document.querySelectorAll(
        'input, textarea, [contenteditable="true"], [role="textbox"]'
      );
      debugLog("All potential input elements:", allInputs.length);
      Array.from(allInputs)
        .slice(0, 3)
        .forEach((el) => logElementDetails(el, "Potential input"));

      // Try to find any button elements for debugging purposes
      const allButtons = document.querySelectorAll("button");
      debugLog("All potential buttons:", allButtons.length);
      Array.from(allButtons)
        .slice(0, 3)
        .forEach((el) => logElementDetails(el, "Potential button"));

      chrome.runtime.sendMessage({
        action: "sendError",
        error: `Chat interface elements not found. Input: ${!!input}, Button: ${!!sendButton}`,
      });
      return false;
    }

    // Reset tracking state when sending a new message
    lastResponse = "";
    isWaitingForResponse = false; // Reset and then set to true later
    clearTimeout(stabilityTimeout);
    clearTimeout(forceResponseTimeout);
    forceResponseTimeout = null;

    // --- Input Handling based on platform ---
    if (isGrok) {
      debugLog("Using Grok input handling");

      if (
        input.matches(
          "div.message-bubble.px-4.py-2\\.5.rounded-br-lg > span > p.break-words"
        )
      ) {
        debugLog("Using precise Grok selector match");
        input.parentElement.parentElement.innerText = message;
        input.parentElement.parentElement.dispatchEvent(
          new Event("input", { bubbles: true })
        );
      } else if (
        input.getAttribute("role") === "textbox" ||
        (input.tagName === "DIV" && input.contentEditable === "true")
      ) {
        debugLog("Using contenteditable div or role=textbox");
        input.innerText = message;
        input.textContent = message;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        // Additional events that might help trigger Grok's input recognition
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.dispatchEvent(
          new KeyboardEvent("keydown", { key: "a", bubbles: true })
        );
      } else if (input.tagName === "TEXTAREA") {
        debugLog("Using textarea for Grok");
        input.value = message;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    } else {
      // ChatGPT (and other standard inputs)
      debugLog("Using standard input handling");
      if (input.tagName === "TEXTAREA" || input.tagName === "INPUT") {
        input.value = message;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      } else if (input.contentEditable === "true") {
        input.innerText = message;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }

    // Wait longer for input update
    await new Promise((resolve) => setTimeout(resolve, 500));

    // --- Input Verification ---
    let inputVerified = false;

    if (
      input.getAttribute("role") === "textbox" ||
      (input.tagName === "DIV" && input.contentEditable === "true")
    ) {
      inputVerified =
        input.innerText === message || input.textContent === message;
      debugLog("Verified contenteditable:", inputVerified);
    } else if (input.tagName === "TEXTAREA" || input.tagName === "INPUT") {
      inputVerified = input.value === message;
      debugLog("Verified input/textarea:", inputVerified);
    } else if (
      input.matches(
        "div.message-bubble.px-4.py-2\\.5.rounded-br-lg > span > p.break-words"
      )
    ) {
      inputVerified = input.parentElement.parentElement.innerText === message;
      debugLog("Verified Grok specific:", inputVerified);
    }

    // Even if verification fails, try to proceed - the input might still work
    if (!inputVerified) {
      debugLog("Warning: Could not verify input text was set correctly");
    }

    // --- Click Send Button ---
    debugLog("Clicking send button");
    sendButton.click();

    // Try alternative methods if regular click might fail
    setTimeout(() => {
      if (!isWaitingForResponse) {
        debugLog("Trying alternative click method");
        sendButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }
    }, 500);

    isWaitingForResponse = true;
    debugLog("Send button clicked, now waiting for response");

    // Set overall timeout - longer timeout to ensure we don't miss responses
    clearTimeout(responseCheckTimeout);
    responseCheckTimeout = setTimeout(() => {
      if (isWaitingForResponse) {
        debugLog("Response timeout reached");

        // Send a timeout error but also try to find any response that might have been missed
        const responseElement = findLatestResponse();
        if (responseElement) {
          const finalResponse = responseElement.textContent.trim();
          if (finalResponse && finalResponse.length > 5) {
            debugLog(
              "Found response after timeout:",
              finalResponse.substring(0, 50)
            );
            isWaitingForResponse = false; // Mark response as processed
            responseSequenceId++;

            chrome.runtime.sendMessage({
              action: "responseReceived",
              response: finalResponse,
              source: isGrok ? "grok" : "chatgpt",
              url: window.location.href,
              sequenceId: responseSequenceId,
              fromTimeout: true,
            });
            return;
          }
        }

        // If no response was found, let background script know about the timeout
        isWaitingForResponse = false; // Reset waiting state
        chrome.runtime.sendMessage({
          action: "responseError",
          error: "No response received within timeout.",
          url: window.location.href,
        });
      }
    }, CONFIG.responseTimeout);

    return true;
  } catch (error) {
    console.error("Failed to send message:", error);
    debugLog("Error in sendMessage:", error);
    chrome.runtime.sendMessage({
      action: "sendError",
      error: error.message,
      url: window.location.href,
    });
    return false;
  }
}

// Listen for messages from the background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  debugLog("Message received:", message.action);

  if (message.action === "sendMessage") {
    sendMessage(message.message).then((result) => {
      sendResponse({ success: result });
    });
    return true; // Keep the message channel open for the async response
  } else if (message.action === "checkAlive") {
    // Simple ping to check if content script is running
    sendResponse({ alive: true, url: window.location.href });
    return true;
  } else if (message.action === "resetResponse") {
    // Reset response tracking
    lastProcessedResponse = null;
    lastResponse = "";
    isWaitingForResponse = false;
    clearTimeout(responseCheckTimeout);
    clearTimeout(stabilityTimeout);
    clearTimeout(forceResponseTimeout);
    forceResponseTimeout = null;
    sendResponse({ success: true });
    return true;
  } else if (message.action === "debugInfo") {
    // Return debug information about the current page state
    const info = {
      url: window.location.href,
      platform: isGrok ? "Grok" : isChatGPT ? "ChatGPT" : "Unknown",
      inputElement: !!findElement(SELECTORS.inputField),
      sendButton: !!findElement(SELECTORS.sendButton),
      responseElement: !!findLatestResponse(),
      isWaitingForResponse: isWaitingForResponse,
      lastResponseLength: lastResponse ? lastResponse.length : 0,
    };
    sendResponse(info);
    return true;
  }
});

// Initial setup - attempt to reset any stale state
setTimeout(() => {
  debugLog("Content script fully initialized");
  // Force a reset of the response tracking state
  lastProcessedResponse = null;
  lastResponse = "";
  isWaitingForResponse = false;
}, 1000);

// Check for any existing responses when the script loads (could be from a previous session)
setTimeout(() => {
  if (!isWaitingForResponse) {
    const responseElement = findLatestResponse();
    if (responseElement) {
      debugLog("Found existing response on page load:");
      logElementDetails(responseElement, "Existing response");
    }
  }
}, 2000);

// Heartbeat to ensure the content script is still running
setInterval(() => {
  debugLog("Content script heartbeat");
}, 30000);

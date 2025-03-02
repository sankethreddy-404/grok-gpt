// --- background.js ---
let currentConversation = null;
let isEnabled = false;
let chatRelaySettings = { urls: [], timeout: 5000, topic: "" }; // Default timeout
const DEBUG = true; // Enable debug logging

// Debug log helper
function debugLog(...args) {
  if (DEBUG) {
    console.log("[Grok-GPT Background]", ...args);
  }
}

const stats = {
  messagesExchanged: 0,
  errors: { network: 0, timeout: 0, other: 0 },
  averageResponseTime: 0,
  totalResponseTime: 0,
  startTime: null,
  connectionDrops: 0,
};

// --- Conversation Logging ---
const CONVERSATION_LOG = {
  maxEntries: 100,
  entries: [],
  currentSessionId: null,
};

function logConversationEntry(type, content, botIndex) {
  const entry = {
    timestamp: Date.now(),
    sessionId: CONVERSATION_LOG.currentSessionId,
    type,
    content,
    botIndex,
    success: true,
  };

  CONVERSATION_LOG.entries.push(entry);
  if (CONVERSATION_LOG.entries.length > CONVERSATION_LOG.maxEntries) {
    CONVERSATION_LOG.entries.shift();
  }

  // Save to storage
  chrome.storage.local.set({
    conversationLog: CONVERSATION_LOG.entries,
  });
}

function startNewConversationSession() {
  CONVERSATION_LOG.currentSessionId = Date.now().toString();
  return CONVERSATION_LOG.currentSessionId;
}
// --- End Conversation Logging ---

function updateStats(type, responseTime = null) {
  if (!stats.startTime) stats.startTime = Date.now();
  if (type === "message" && responseTime) {
    stats.messagesExchanged++;
    stats.totalResponseTime += responseTime;
    stats.averageResponseTime =
      stats.totalResponseTime / stats.messagesExchanged;
  } else if (stats.errors[type] !== undefined) {
    stats.errors[type]++;
  } else {
    stats.errors.other++;
  }
  chrome.action.setBadgeText({
    text: isEnabled ? stats.messagesExchanged.toString() : "OFF",
  });
}

function handleError(error) {
  console.error("Error:", error);
  updateStats("other");
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/african-mask.png",
    title: "Chat Relay Error",
    message: error.message || "An unknown error occurred",
  });
}

function updateExtensionState() {
  chrome.action.setBadgeText({ text: isEnabled ? "ON" : "OFF" });
  chrome.action.setBadgeBackgroundColor({
    color: isEnabled ? "#00FF00" : "#FF0000",
  });
  chrome.runtime
    .sendMessage({
      action: "statusUpdate",
      enabled: isEnabled,
      stats: getStats(), //Send stats too
      log: CONVERSATION_LOG.entries,
    })
    .catch(() => {});
}

// Check if content script is loaded and responsive
async function checkContentScriptStatus(tabId) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, { action: "checkAlive" }, (response) => {
        if (chrome.runtime.lastError) {
          debugLog(
            "Content script check failed:",
            chrome.runtime.lastError.message
          );
          resolve(false);
        } else if (response && response.alive) {
          debugLog(
            "Content script is alive on tab:",
            tabId,
            "URL:",
            response.url
          );
          resolve(true);
        } else {
          debugLog(
            "Content script check returned unexpected response:",
            response
          );
          resolve(false);
        }
      });
    } catch (error) {
      debugLog("Error checking content script status:", error);
      resolve(false);
    }
  });
}

// Ensure content script is loaded
async function ensureContentScriptLoaded(tabId) {
  try {
    const isLoaded = await checkContentScriptStatus(tabId);

    if (!isLoaded) {
      debugLog("Content script not loaded, injecting now on tab:", tabId);
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: ["content.js"],
      });

      // Wait for script to initialize
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Check if it's now loaded
      const nowLoaded = await checkContentScriptStatus(tabId);
      if (!nowLoaded) {
        throw new Error("Failed to load content script even after injection");
      }
      debugLog("Content script successfully injected");
    }

    return true;
  } catch (error) {
    debugLog("Error ensuring content script:", error);
    return false;
  }
}

// Send message to tab with retry
async function sendMessageToTab(tabId, message, maxRetries = 3) {
  let retries = 0;
  let success = false;

  while (retries < maxRetries && !success) {
    try {
      // Ensure content script is loaded first
      const isLoaded = await ensureContentScriptLoaded(tabId);
      if (!isLoaded) {
        throw new Error("Content script not available");
      }

      return new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, message, (response) => {
          if (chrome.runtime.lastError) {
            reject(
              new Error(
                `Tab message failed: ${chrome.runtime.lastError.message}`
              )
            );
          } else {
            success = true;
            debugLog(
              "Message sent successfully to tab:",
              tabId,
              "Response:",
              response
            );
            resolve(response);
          }
        });
      });
    } catch (error) {
      retries++;
      debugLog(`Attempt ${retries}/${maxRetries} failed:`, error);

      if (retries >= maxRetries) {
        handleError(
          new Error(
            `Failed to send message to tab after ${maxRetries} attempts: ${error.message}`
          )
        );
        return false;
      }

      // Wait before retry
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

async function startChatRelay(topic) {
  if (!isEnabled) return;

  try {
    debugLog("Starting chat relay with topic:", topic);
    const items = chatRelaySettings;
    if (!items.urls || items.urls.length !== 2) {
      throw new Error("Need exactly 2 URLs for chat relay.");
    }

    const [grokUrl, chatGPTUrl] = items.urls;
    const timeout = items.timeout || 5000;

    debugLog("Creating windows with URLs:", grokUrl, chatGPTUrl);
    const window = await chrome.windows.create({
      url: [grokUrl, chatGPTUrl],
      focused: true,
    });

    if (!window.tabs || window.tabs.length !== 2) {
      throw new Error("Failed to create window with tabs.");
    }

    const [grokTabId, chatGPTTabId] = window.tabs.map((tab) => tab.id);

    currentConversation = {
      tabs: [grokTabId, chatGPTTabId],
      currentBot: 0, // 0 = Grok, 1 = ChatGPT
      topic: topic,
      lastMessageTime: Date.now(),
      debateHistory: [], // Track debate history
      urls: [grokUrl, chatGPTUrl], // Store URLs for reference
    };

    startNewConversationSession();
    debugLog("Created conversation session");

    // Wait for tabs to load
    debugLog(`Waiting ${timeout}ms for tabs to load...`);
    await new Promise((resolve) => setTimeout(resolve, timeout));

    // Verify content script is loaded in both tabs
    debugLog("Checking if content script is loaded in tabs");
    const grokScriptLoaded = await ensureContentScriptLoaded(grokTabId);
    const chatGPTScriptLoaded = await ensureContentScriptLoaded(chatGPTTabId);

    if (!grokScriptLoaded || !chatGPTScriptLoaded) {
      throw new Error("Failed to ensure content scripts are loaded");
    }

    // --- Construct initial prompts ---
    const initialPromptGrok = `Debate Topic: ${topic}. Present your arguments concisely, as if in a human conversation. Aim for responses of around 2-4 sentences. Do not reveal that you are an AI or chatbot. Please start with your opening statement.`;
    const initialPromptChatGPT = "Waiting for the initial statement...";

    debugLog("Sending initial prompt to Grok");
    // Send to Grok (Tab 1) first
    await sendMessageToTab(grokTabId, {
      action: "sendMessage",
      message: initialPromptGrok,
    });

    // Now send to ChatGPT (Tab 2)
    debugLog("Sending initial prompt to ChatGPT");
    await sendMessageToTab(chatGPTTabId, {
      action: "sendMessage",
      message: initialPromptChatGPT,
    });

    logConversationEntry("topic", topic, null);
    updateStats("message");
    debugLog("Chat relay started successfully");
  } catch (error) {
    debugLog("Error starting chat relay:", error);
    handleError(error);
  }
}

async function stopAllProcesses() {
  debugLog("Stopping all processes");
  if (currentConversation) {
    for (const tabId of currentConversation.tabs) {
      try {
        await chrome.tabs.remove(tabId);
        debugLog("Removed tab:", tabId);
      } catch (e) {
        debugLog("Error removing tab:", e);
        /* Tab might already be closed */
      }
    }
    currentConversation = null;
  }
  resetStats();
  chrome.storage.local.remove("sessionState");
  chrome.action.setBadgeText({ text: "OFF" });
}

function resetStats() {
  // Safety check to ensure stats is an object before accessing it
  if (!stats || typeof stats !== "object") {
    stats = {
      messagesExchanged: 0,
      errors: { network: 0, timeout: 0, other: 0 },
      averageResponseTime: 0,
      totalResponseTime: 0,
      startTime: null,
      connectionDrops: 0,
    };
    return;
  }

  // Reset numerical properties
  Object.keys(stats).forEach((key) => {
    if (typeof stats[key] === "number") {
      stats[key] = 0;
    }
    // Reset nested objects (like errors) with safety check
    else if (typeof stats[key] === "object" && stats[key] !== null) {
      Object.keys(stats[key]).forEach((k) => {
        stats[key][k] = 0;
      });
    }
  });
  stats.startTime = null;
}

function getStats() {
  // Safety check to ensure stats is a valid object
  if (!stats || typeof stats !== "object") {
    return {
      messagesExchanged: 0,
      errors: { network: 0, timeout: 0, other: 0 },
      averageResponseTime: 0,
      totalResponseTime: 0,
      startTime: null,
      connectionDrops: 0,
      runningTime: 0,
      successRate: 0,
    };
  }

  const runningTime = stats.startTime ? Date.now() - stats.startTime : 0;

  // Safely calculate total errors
  let totalErrors = 0;
  if (stats.errors && typeof stats.errors === "object") {
    totalErrors = Object.values(stats.errors).reduce(
      (a, b) => a + (isNaN(b) ? 0 : b),
      0
    );
  }

  // Safely calculate success rate
  const successRate = stats.messagesExchanged
    ? (
        ((stats.messagesExchanged - totalErrors) / stats.messagesExchanged) *
        100
      ).toFixed(2)
    : 0;

  return {
    ...stats,
    runningTime,
    successRate,
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  debugLog(
    "Received message:",
    message.action,
    "from sender:",
    sender?.tab?.id
  );

  if (message.action === "startChatRelay") {
    isEnabled = true;
    updateExtensionState();
    startChatRelay(message.topic);
    sendResponse({ status: "starting" });
    return true; // Important for async
  }

  if (
    !isEnabled &&
    message.action !== "settingsUpdated" &&
    message.action !== "getStats" &&
    message.action !== "getConversationLog" &&
    message.action !== "getSnapshots" &&
    message.action !== "getBackups"
  ) {
    debugLog("Extension is disabled, ignoring message:", message.action);
    sendResponse({ status: "disabled" });
    return true;
  }

  switch (message.action) {
    case "stopChatRelay":
      stopAllProcesses();
      sendResponse({ status: "stopped" });
      break;

    case "responseReceived":
      // --- Make the ENTIRE handler async ---
      (async () => {
        if (currentConversation && sender.tab?.id) {
          try {
            debugLog("Response received from tab:", sender.tab.id);
            const responseTime =
              Date.now() - currentConversation.lastMessageTime;
            updateStats("message", responseTime);
            currentConversation.lastMessageTime = Date.now();

            const currentBotIndex = currentConversation.tabs.indexOf(
              sender.tab.id
            );
            if (currentBotIndex === -1) {
              debugLog("Response from unknown tab:", sender.tab.id);
              return;
            }

            const nextBotIndex = (currentBotIndex + 1) % 2;
            const nextBotTabId = currentConversation.tabs[nextBotIndex];

            // Determine which bot responded (Grok or ChatGPT)
            const source =
              message.source || (currentBotIndex === 0 ? "grok" : "chatgpt");
            debugLog(
              `Received response from ${source}:`,
              message.response.substring(0, 50) + "..."
            );

            // Store response in debate history
            currentConversation.debateHistory.push({
              source: source,
              response: message.response,
              timestamp: Date.now(),
            });

            // Log the conversation entry
            logConversationEntry("response", message.response, currentBotIndex);

            // --- Construct the follow-up prompt based on debate history ---
            let followUpPrompt;

            if (
              currentConversation.debateHistory.length === 1 &&
              source === "grok"
            ) {
              // This is the first response from Grok, send to ChatGPT with debate context
              followUpPrompt = `This is a debate on the topic: ${currentConversation.topic}\n\nThe other participant stated: "${message.response}"\n\nPlease respond with your perspective on this topic. Keep your response concise (2-4 sentences) and engage directly with their points.`;
            } else {
              // For subsequent messages, include the debate history
              const lastResponse = message.response;
              followUpPrompt = `Continuing our debate on: ${currentConversation.topic}\n\nThe other participant just said: "${lastResponse}"\n\nRespond directly to their points. Keep your response concise (2-4 sentences).`;
            }

            // --- First activate the tab, then send the message ---
            debugLog("Activating next tab:", nextBotTabId);
            await chrome.tabs.update(nextBotTabId, { active: true });

            // Wait a moment for tab to become active
            await new Promise((resolve) => setTimeout(resolve, 500));

            debugLog("Sending message to next bot");
            await sendMessageToTab(nextBotTabId, {
              action: "sendMessage",
              message: followUpPrompt,
            });
          } catch (error) {
            debugLog("Error handling response:", error);
            handleError(new Error(`Error handling response: ${error.message}`));
          }
        } else {
          debugLog(
            "Received response but no active conversation or sender tab"
          );
        }
      })();
      sendResponse({ status: "processing" }); // Respond immediately
      return true; // Keep the message channel open for the async function

    case "sendError":
    case "responseError":
    case "initError":
      debugLog("Error reported:", message.error);
      handleError(new Error(message.error));
      sendResponse({ status: "error_logged" });
      break;

    case "settingsUpdated":
      chatRelaySettings = message.settings;
      debugLog("Settings updated:", chatRelaySettings);
      sendResponse({ status: "settings_updated" });
      break;

    case "getStats":
      const stats = getStats();
      debugLog("Stats requested:", stats);
      sendResponse(stats);
      break;

    case "getConversationLog":
      debugLog("Conversation log requested");
      sendResponse({ log: CONVERSATION_LOG.entries });
      break;

    case "resetStats":
      debugLog("Stats reset requested");
      resetStats();
      sendResponse({ status: "stats_reset" });
      break;

    default:
      debugLog("Unhandled message:", message);
      sendResponse({ status: "unknown_action" });
  }
  return true; // Keep the message channel open
});

chrome.action.onClicked.addListener(async (tab) => {
  isEnabled = !isEnabled;
  debugLog("Extension toggled:", isEnabled ? "ON" : "OFF");
  await chrome.storage.sync.set({ enabled: isEnabled });
  updateExtensionState();

  if (isEnabled) {
    const items = await chrome.storage.sync.get(["urls", "timeout", "topic"]);
    chatRelaySettings = items;
    debugLog("Loaded settings:", chatRelaySettings);

    if (items.topic) {
      startChatRelay(items.topic);
    } else {
      debugLog("No topic set, not starting chat relay");
    }
  } else {
    await stopAllProcesses();
  }
});

// --- Initialization (onInstalled, etc.) ---
chrome.runtime.onInstalled.addListener(() => {
  debugLog("Extension installed/updated");
  chrome.storage.sync
    .get(["urls", "timeout", "enabled", "topic"])
    .then((items) => {
      if (!items.urls || !items.timeout) {
        const defaultSettings = {
          urls: ["https://grok.x.ai", "https://chat.openai.com"], // Order matters! Grok first, ChatGPT second
          timeout: 5000, // Default timeout
          enabled: false,
          topic: "Debate on the benefits of AI",
        };

        debugLog("Initializing with default settings:", defaultSettings);
        chrome.storage.sync.set(defaultSettings);
        chatRelaySettings = defaultSettings;
      } else {
        debugLog("Loaded settings:", items);
        chatRelaySettings = items;
      }

      isEnabled = items.enabled || false;
      updateExtensionState();
    });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (currentConversation?.tabs.includes(tabId)) {
    debugLog("Conversation tab closed:", tabId);
    currentConversation = null;
  }
});

// Keyboard command handling
chrome.commands.onCommand.addListener(async (command) => {
  debugLog("Command received:", command);

  switch (command) {
    case "toggle-extension":
      try {
        isEnabled = !isEnabled;
        await chrome.storage.sync.set({ enabled: isEnabled });
        updateExtensionState();
        debugLog("Extension toggled via command:", isEnabled ? "ON" : "OFF");

        if (!isEnabled) {
          await stopAllProcesses();
        }
      } catch (error) {
        debugLog("Error toggling extension:", error);
        handleError(error);
      }
      break;

    case "start-chat":
      if (!isEnabled) {
        debugLog("Cannot start chat - extension is disabled");
        chrome.notifications.create({
          type: "basic",
          iconUrl: "icons/african-mask.png",
          title: "Chat Relay",
          message: "Please enable the extension first",
        });
        return;
      }

      try {
        const { topic } = await chrome.storage.sync.get("topic");
        if (!topic) {
          debugLog("Cannot start chat - no topic set");
          chrome.notifications.create({
            type: "basic",
            iconUrl: "icons/african-mask.png",
            title: "Chat Relay",
            message: "Please set a conversation topic in options",
          });
          return;
        }
        debugLog("Starting chat via command with topic:", topic);
        startChatRelay(topic);
      } catch (error) {
        debugLog("Error starting chat:", error);
        handleError(error);
      }
      break;

    case "stop-chat":
      debugLog("Stopping chat via command");
      await stopAllProcesses();
      break;
  }
});

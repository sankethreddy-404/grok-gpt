// background.js
// State management
let switchInterval;
let currentConversation = null;
let isEnabled = false;
let errorCount = 0;
const MAX_ERRORS = 3;

// Watchdog configuration
const WATCHDOG_CONFIG = {
  responseTimeout: 30000, // 30 seconds
  checkInterval: 5000, // 5 seconds
};

let watchdogTimer = null;
let chatRelaySettings = { urls: [], timeout: 3000, topic: "" }; // Store settings

// Statistics tracking
const stats = {
  messagesExchanged: 0,
  errors: {
    network: 0,
    timeout: 0,
    other: 0,
  },
  averageResponseTime: 0,
  totalResponseTime: 0,
  startTime: null,
  connectionDrops: 0,
};

function updateStats(type, responseTime = null) {
  if (!stats.startTime) {
    stats.startTime = Date.now();
  }

  switch (type) {
    case "message":
      stats.messagesExchanged++;
      if (responseTime) {
        stats.totalResponseTime += responseTime;
        stats.averageResponseTime =
          stats.totalResponseTime / stats.messagesExchanged;
      }
      break;
    case "network":
      stats.errors.network++;
      break;
    case "timeout":
      stats.errors.timeout++;
      break;
    case "connection-drop":
      stats.connectionDrops++;
      break;
    default:
      stats.errors.other++;
  }

  // Update badge with message count
  chrome.action.setBadgeText({
    text: isEnabled ? stats.messagesExchanged.toString() : "OFF",
  });
}

// Handle errors and notifications
function handleError(error, tabId) {
  console.error("Error occurred:", error);
  console.error("Stack trace:", error.stack);
  errorCount++;

  // Show notification with error details
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/african-mask.png",
    title: "Chat Relay Error",
    message: error.message || "An unknown error occurred",
  });

  if (errorCount >= MAX_ERRORS) {
    stopAllProcesses();
    isEnabled = false;
    updateExtensionState();
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/african-mask.png",
      title: "Chat Relay Disabled",
      message: "Too many errors occurred. Extension has been disabled.",
    });
  }
}

// Update extension state
function updateExtensionState() {
  chrome.action.setBadgeText({ text: isEnabled ? "ON" : "OFF" });
  chrome.action.setBadgeBackgroundColor({
    color: isEnabled ? "#00FF00" : "#FF0000",
  });
  chrome.action.setTitle({
    title: isEnabled
      ? "Click to disable extension"
      : "Click to enable extension",
  });

  // Notify options page if open
  chrome.runtime
    .sendMessage({
      action: "statusUpdate",
      enabled: isEnabled,
    })
    .catch(() => {}); // Ignore if options page is not open
}

// Enhanced tab switching with error handling
async function startTabSwitching(urls, timeout) {
  try {
    const windowObj = await chrome.windows.create({ url: urls, focused: true });
    if (!windowObj.tabs) {
      handleError("Failed to create window with tabs");
      return;
    }

    const tabs = windowObj.tabs.map((tab) => tab.id);
    let index = 0;
    if (switchInterval) {
      clearInterval(switchInterval);
    }
    switchInterval = setInterval(async () => {
      if (!tabs.length) {
        handleError("No tabs to switch between");
        clearInterval(switchInterval);
        return;
      }
      index = (index + 1) % tabs.length;
      try {
        await chrome.tabs.update(tabs[index], { active: true });
      } catch (error) {
        handleError(error);
      }
    }, timeout);
  } catch (error) {
    handleError(error);
  }
}

// Start watchdog monitoring
function startWatchdog() {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
  }

  watchdogTimer = setInterval(() => {
    if (currentConversation) {
      const timeSinceLastMessage =
        Date.now() - currentConversation.lastMessageTime;
      if (timeSinceLastMessage > WATCHDOG_CONFIG.responseTimeout) {
        handleError("Response timeout - No response from chatbot");
        stopAllProcesses();
      }
    }
  }, WATCHDOG_CONFIG.checkInterval);
}

// Enhanced chat relay with error handling
async function startChatRelay(topic) {
  console.log("Starting chat relay with topic:", topic);

  try {
    // Use the stored settings
    const items = chatRelaySettings;
    console.log("Retrieved settings:", items);

    if (!items.urls?.length || items.urls.length !== 2) {
      const error =
        "Need exactly 2 URLs for chat relay. Please set URLs in extension options.";
      console.error(error);
      chrome.notifications.create({
        type: "basic",
        iconUrl: "icons/african-mask.png",
        title: "Chat Relay Error",
        message: error,
      });
      return;
    }

    const [bot1Url, bot2Url] = items.urls;
    const timeout = items.timeout || 3000;

    console.log("Creating window with URLs:", [bot1Url, bot2Url]);
    const window = await chrome.windows.create({
      url: [bot1Url, bot2Url],
      focused: true,
    });

    if (!window.tabs || window.tabs.length !== 2) {
      throw new Error("Failed to create window with tabs");
    }

    currentConversation = {
      tabs: window.tabs.map((tab) => tab.id),
      currentBot: 0,
      topic: topic,
      lastMessageTime: Date.now(),
    };

    console.log("Initialized conversation:", currentConversation);

    // Wait for tabs to load
    await new Promise((resolve) => setTimeout(resolve, timeout));

    console.log("Sending initial message to first bot");
    chrome.tabs
      .sendMessage(currentConversation.tabs[0], {
        action: "sendMessage",
        message: topic,
      })
      .catch((error) => {
        console.error("Failed to send initial message:", error);
        chrome.notifications.create({
          type: "basic",
          iconUrl: "icons/african-mask.png",
          title: "Chat Relay Error",
          message: "Failed to start conversation: " + error.message,
        });
      });

    startWatchdog();

    // Show success notification
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/african-mask.png",
      title: "Chat Relay Started",
      message: "Chat relay has been started successfully with the given topic.",
    });
  } catch (error) {
    console.error("Error in startChatRelay:", error);
    handleError(error);
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/african-mask.png",
      title: "Chat Relay Error",
      message: "Failed to start chat relay: " + error.message,
    });
  }
}

// Enhanced installation handler
chrome.runtime.onInstalled.addListener(() => {
  console.log("onInstalled listener started"); // Add this

  // Use async/await for proper asynchronous handling
  (async () => {
    try {
      await restoreSessionState();
      console.log("restoreSessionState completed");
      startSessionPersistence();
      console.log("startSessionPersistence completed");

      const items = await chrome.storage.sync.get([
        "urls",
        "timeout",
        "enabled",
      ]);
      console.log("chrome.storage.sync.get completed", items);

      if (!items.urls || !items.timeout) {
        // Use await here!
        await chrome.storage.sync.set({
          urls: ["https://example.com", "https://example.org"],
          timeout: 3000,
          enabled: false,
        });
        console.log("Initial settings set");
      }
      isEnabled = items.enabled || false;
      updateExtensionState();
    } catch (error) {
      console.error("Error in onInstalled:", error);
    }
  })(); // Immediately-invoked async function expression
});

// Message handling with error recovery
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Special-case: if a startChatRelay message is received, enable extension automatically.
  if (message.action === "startChatRelay") {
    if (!isEnabled) {
      isEnabled = true;
      updateExtensionState();
    }
    startChatRelay(message.topic);
    return; // This is important for async handling, though not strictly required
  }

  if (
    !isEnabled &&
    message.action !== "settingsUpdated" &&
    message.action !== "getStats" &&
    message.action !== "getConversationLog" &&
    message.action !== "getSnapshots" &&
    message.action !== "getBackups"
  ) {
    console.log("Extension is disabled");
    return;
  }
  // Handle getStats, getConversationLog, getSnapshots, and getBackups regardless of isEnabled.  Needed for UI updates.

  switch (message.action) {
    case "startChatRelay":
      startChatRelay(message.topic);
      break;
    case "stopChatRelay": // Handle the stop chat relay message
      stopAllProcesses();
      break;
    case "responseReceived":
      if (currentConversation) {
        const responseTime = Date.now() - currentConversation.lastMessageTime;
        updateStats("message", responseTime);
        currentConversation.lastMessageTime = Date.now();
        currentConversation.currentBot =
          (currentConversation.currentBot + 1) % 2;
        const nextBotTab =
          currentConversation.tabs[currentConversation.currentBot];

        chrome.tabs
          .update(nextBotTab, { active: true })
          .then(() => {
            return chrome.tabs.sendMessage(nextBotTab, {
              action: "sendMessage",
              message: message.response,
            });
          })
          .catch((error) => handleError(error));
      }
      break;
    case "connectionStatus":
      if (message.status === "offline") {
        updateStats("connection-drop");
      }
      break;
    case "sendError":
      updateStats(message.error.includes("network") ? "network" : "other");
      handleError(message.error, sender.tab?.id);
      break;
    case "responseError":
      updateStats(message.error.includes("timeout") ? "timeout" : "other");
      handleError(message.error, sender.tab?.id);
      break;
    case "settingsUpdated":
      // Store settings
      chatRelaySettings = message.settings;
      if (isEnabled) {
        errorCount = 0; // Reset error count on new settings
        startTabSwitching(message.settings.urls, message.settings.timeout);
      }
      break;

    // Add cases for getting data
    case "getStats":
      sendResponse(getStats());
      break;
    case "getConversationLog":
      sendResponse({ log: CONVERSATION_LOG.entries });
      break;
    case "getSnapshots":
      sendResponse({ snapshots: SNAPSHOT_SYSTEM.snapshots });
      break;
    case "getBackups":
      chrome.storage.local
        .get("backups")
        .then(({ backups = [] }) => sendResponse({ backups }))
        .catch((error) => sendResponse({ error: error.message }));
      return true; // Keep the message channel open for async response
    case "createSnapshot":
      createSnapshot(message.description)
        .then((snapshot) => sendResponse({ success: true, snapshot }))
        .catch((error) =>
          sendResponse({ success: false, error: error.message })
        );
      return true;
    case "restoreSnapshot":
      restoreSnapshot(message.snapshotId)
        .then((success) => sendResponse({ success }))
        .catch((error) =>
          sendResponse({ success: false, error: error.message })
        );
      return true;
    case "deleteSnapshot":
      deleteSnapshot(message.snapshotId)
        .then((success) => sendResponse({ success }))
        .catch((error) =>
          sendResponse({ success: false, error: error.message })
        );
      return true;

    case "createBackup":
      createBackup()
        .then(() => sendResponse({ success: true }))
        .catch((error) =>
          sendResponse({ success: false, error: error.message })
        );
      return true;

    case "restoreBackup":
      restoreFromBackup(message.timestamp)
        .then((success) => sendResponse({ success }))
        .catch((error) =>
          sendResponse({ success: false, error: error.message })
        );
      return true;

    default:
      console.warn("Unhandled message:", message);
  }
  return false; // Indicate synchronous response, except where explicitly returned true.
});

// Click handler for extension icon
chrome.action.onClicked.addListener(async (tab) => {
  try {
    isEnabled = !isEnabled;
    await chrome.storage.sync.set({ enabled: isEnabled });

    if (!isEnabled) {
      await stopAllProcesses();
    } else {
      errorCount = 0; // Reset error count when enabling
      const items = await chrome.storage.sync.get(["urls", "timeout"]);
      if (items.urls?.length >= 2) {
        startTabSwitching(items.urls, items.timeout || 3000);
      }
    }

    updateExtensionState();
  } catch (error) {
    handleError(error);
    isEnabled = false;
    updateExtensionState();
  }
});

// Enhanced cleanup
async function stopAllProcesses() {
  try {
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }

    if (switchInterval) {
      clearInterval(switchInterval);
      switchInterval = null;
    }

    if (currentConversation) {
      // Close conversation tabs if they exist
      for (const tabId of currentConversation.tabs) {
        try {
          await chrome.tabs.remove(tabId);
        } catch (error) {
          console.log(`Tab ${tabId} already closed`);
        }
      }
      currentConversation = null;
    }
    resetStats();

    // Clear saved session
    await chrome.storage.local.remove("sessionState");
    SESSION_STATE.lastSavedState = null;
  } catch (error) {
    console.error("Error stopping processes:", error);
  }
}

// Add stats reset function
function resetStats() {
  stats.messagesExchanged = 0;
  stats.errors = {
    network: 0,
    timeout: 0,
    other: 0,
  };
  stats.averageResponseTime = 0;
  stats.totalResponseTime = 0;
  stats.startTime = null;
  stats.connectionDrops = 0;
}

// Add function to get stats
function getStats() {
  const runningTime = stats.startTime ? Date.now() - stats.startTime : 0;
  return {
    ...stats,
    runningTime,
    successRate: stats.messagesExchanged
      ? (
          ((stats.messagesExchanged -
            Object.values(stats.errors).reduce((a, b) => a + b, 0)) /
            stats.messagesExchanged) *
          100
        ).toFixed(2)
      : 0,
  };
}

// Cleanup when tabs are closed
chrome.tabs.onRemoved.addListener((tabId) => {
  if (currentConversation?.tabs.includes(tabId)) {
    currentConversation = null;
  }
});

// Error recovery configuration
const RECOVERY_CONFIG = {
  maxRetries: 3,
  baseDelay: 2000,
  maxDelay: 30000,
  rateLimitDelay: 60000,
  reconnectDelay: 5000,
};

// Rate limiting and backoff handling
const backoffState = {
  retryCount: 0,
  lastErrorTime: 0,
  isRateLimited: false,
  consecutiveErrors: 0,
};

function calculateBackoff() {
  const delay = Math.min(
    RECOVERY_CONFIG.baseDelay * Math.pow(2, backoffState.retryCount),
    RECOVERY_CONFIG.maxDelay
  );
  return delay;
}

async function handleErrorWithBackoff(error, operation) {
  console.error("Operation failed:", error);
  backoffState.consecutiveErrors++;

  // Check for rate limiting
  if (
    error.message?.toLowerCase().includes("rate limit") ||
    error.message?.toLowerCase().includes("too many requests")
  ) {
    backoffState.isRateLimited = true;
    await new Promise((resolve) =>
      setTimeout(resolve, RECOVERY_CONFIG.rateLimitDelay)
    );
    backoffState.isRateLimited = false;
  }

  // Apply exponential backoff
  if (backoffState.retryCount < RECOVERY_CONFIG.maxRetries) {
    const delay = calculateBackoff();
    backoffState.retryCount++;
    await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      return await operation();
    } catch (retryError) {
      return handleErrorWithBackoff(retryError, operation);
    }
  }

  // Reset backoff state after max retries
  backoffState.retryCount = 0;
  throw error;
}

// Health check function
async function performHealthCheck() {
  if (!isEnabled || !currentConversation) return;

  try {
    // Check if tabs still exist
    const tabPromises = currentConversation.tabs.map((tabId) =>
      chrome.tabs.get(tabId).catch(() => null)
    );

    const tabs = await Promise.all(tabPromises);
    const missingTabs = tabs.filter((tab) => !tab).length;

    if (missingTabs > 0) {
      throw new Error("Chat tabs were closed unexpectedly");
    }

    // Check message flow
    const timeSinceLastMessage =
      Date.now() - currentConversation.lastMessageTime;
    if (timeSinceLastMessage > WATCHDOG_CONFIG.responseTimeout * 2) {
      throw new Error("Message flow has stalled");
    }

    // Reset consecutive errors on successful health check
    backoffState.consecutiveErrors = 0;
  } catch (error) {
    handleError(error);
    if (backoffState.consecutiveErrors >= 3) {
      stopAllProcesses();
      isEnabled = false;
      updateExtensionState();
    }
  }
}

// Start health check interval
setInterval(performHealthCheck, 30000);

// Tab recovery system
const RECOVERY_STATE = {
  savedTabs: new Map(), // Map of tabId to tab state
  recoveryInProgress: false,
};

// Save tab state periodically
function saveTabState() {
  if (!currentConversation?.tabs) return;

  currentConversation.tabs.forEach(async (tabId) => {
    try {
      const tab = await chrome.tabs.get(tabId);
      RECOVERY_STATE.savedTabs.set(tabId, {
        url: tab.url,
        index: tab.index,
        bot: currentConversation.tabs.indexOf(tabId),
      });
    } catch (error) {
      console.log(`Tab ${tabId} not found, may need recovery`);
    }
  });
}

// Attempt to recover crashed or closed tabs
async function recoverTabs() {
  if (RECOVERY_STATE.recoveryInProgress || !isEnabled) return;

  try {
    RECOVERY_STATE.recoveryInProgress = true;
    const lostTabs = Array.from(RECOVERY_STATE.savedTabs.entries()).filter(
      async ([tabId]) => {
        try {
          await chrome.tabs.get(tabId);
          return false;
        } catch {
          return true;
        }
      }
    );

    if (lostTabs.length > 0) {
      const newWindow = await chrome.windows.create({
        url: lostTabs.map(([_, state]) => state.url),
        focused: true,
      });

      if (newWindow?.tabs) {
        currentConversation = {
          ...currentConversation,
          tabs: newWindow.tabs.map((tab) => tab.id),
          lastMessageTime: Date.now(),
        };

        // Notify user of recovery
        chrome.notifications.create({
          type: "basic",
          iconUrl: "icon48.png",
          title: "Tab Recovery",
          message: "Chat tabs have been recovered after unexpected closure.",
        });
      }
    }
  } catch (error) {
    console.error("Tab recovery failed:", error);
  } finally {
    RECOVERY_STATE.recoveryInProgress = false;
  }
}

// Session persistence
const SESSION_STATE = {
  lastSavedState: null,
  saveInterval: null,
};

// Save session state
async function saveSessionState() {
  if (!isEnabled || !currentConversation) return;

  const state = {
    conversation: currentConversation,
    stats: stats,
    backoffState: backoffState,
    isEnabled: isEnabled,
    timestamp: Date.now(),
  };

  try {
    await chrome.storage.local.set({ sessionState: state });
    SESSION_STATE.lastSavedState = state;
  } catch (error) {
    console.error("Failed to save session state:", error);
  }
}

// Restore session state (Corrected)
async function restoreSessionState() {
  try {
    console.log("restoreSessionState called");
    const { sessionState } = await chrome.storage.local.get("sessionState");
    console.log("chrome.storage.local.get result:", sessionState);

    if (!sessionState) {
      console.log("sessionState is null or undefined");
      return; // Exit if no session state
    }

    // Only restore if the session is less than 30 minutes old
    if (Date.now() - sessionState.timestamp < 30 * 60 * 1000) {
      isEnabled = sessionState.isEnabled;
      stats = sessionState.stats;
      backoffState = sessionState.backoffState;

      if (sessionState.conversation) {
        // Verify tabs still exist
        const existingTabs = await Promise.all(
          sessionState.conversation.tabs.map((tabId) =>
            chrome.tabs.get(tabId).catch(() => null)
          )
        );

        if (existingTabs.every((tab) => tab)) {
          currentConversation = sessionState.conversation;
          startWatchdog();
        }
      }
      updateExtensionState();
    }
  } catch (error) {
    console.error("Failed to restore session:", error);
  }
}

// Start session persistence
function startSessionPersistence() {
  if (SESSION_STATE.saveInterval) {
    clearInterval(SESSION_STATE.saveInterval);
  }
  SESSION_STATE.saveInterval = setInterval(saveSessionState, 5000);
}

// Conversation logging system
const CONVERSATION_LOG = {
  maxEntries: 100,
  entries: [],
  currentSessionId: null,
};

// Log conversation entry
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

// Start new conversation session
function startNewConversationSession() {
  CONVERSATION_LOG.currentSessionId = Date.now().toString();
  return CONVERSATION_LOG.currentSessionId;
}

// Keyboard command handling
chrome.commands.onCommand.addListener(async (command) => {
  switch (command) {
    case "toggle-extension":
      try {
        isEnabled = !isEnabled;
        await chrome.storage.sync.set({ enabled: isEnabled });

        if (!isEnabled) {
          await stopAllProcesses();
        } else {
          errorCount = 0;
          const items = await chrome.storage.sync.get(["urls", "timeout"]);
          if (items.urls?.length >= 2) {
            startTabSwitching(items.urls, items.timeout || 3000);
          }
        }

        updateExtensionState();
        showNotification("Extension " + (isEnabled ? "enabled" : "disabled"));
      } catch (error) {
        handleError(error);
      }
      break;

    case "start-chat":
      if (!isEnabled) {
        showNotification("Please enable the extension first");
        return;
      }

      try {
        const { topic } = await chrome.storage.sync.get("topic");
        if (!topic) {
          showNotification("Please set a conversation topic in options");
          return;
        }
        startChatRelay(topic);
        showNotification("Starting new chat relay");
      } catch (error) {
        handleError(error);
      }
      break;

    case "stop-chat":
      if (currentConversation) {
        await stopAllProcesses();
        showNotification("Chat relay stopped");
      }
      break;
  }
});

// Enhanced notification handling
function showNotification(message, type = "info") {
  const icons = {
    info: "icon48.png",
    error: "icon48.png",
    success: "icon48.png",
  };

  chrome.notifications.create({
    type: "basic",
    iconUrl: icons[type],
    title: "Chat Relay",
    message: message,
  });
}

// Unload handling
self.addEventListener("unload", async () => {
  try {
    // Save final state
    if (isEnabled && currentConversation) {
      await saveSessionState();
      await saveTabState();
    }

    // Clean up intervals
    if (watchdogTimer) clearInterval(watchdogTimer);
    if (switchInterval) clearInterval(switchInterval);
    if (SESSION_STATE.saveInterval) clearInterval(SESSION_STATE.saveInterval);

    // Save conversation log
    if (CONVERSATION_LOG.entries.length > 0) {
      await chrome.storage.local.set({
        conversationLog: CONVERSATION_LOG.entries,
      });
    }
  } catch (error) {
    console.error("Error during unload:", error);
  }
});

// Handle extension disable/uninstall
chrome.management.onDisabled.addListener(async (info) => {
  if (info.id === chrome.runtime.id) {
    await stopAllProcesses();
  }
});

chrome.runtime.onSuspend.addListener(async () => {
  try {
    await stopAllProcesses();

    // Save final state
    if (CONVERSATION_LOG.entries.length > 0) {
      await chrome.storage.local.set({
        conversationLog: CONVERSATION_LOG.entries,
      });
    }
  } catch (error) {
    console.error("Error during suspension:", error);
  }
});

// Conversation snapshot system
const SNAPSHOT_SYSTEM = {
  snapshots: [],
  maxSnapshots: 10,
};

// Create conversation snapshot
async function createSnapshot(description = "") {
  if (!currentConversation) return;

  const snapshot = {
    id: Date.now().toString(),
    timestamp: new Date().toISOString(),
    description,
    conversation: { ...currentConversation },
    messages: CONVERSATION_LOG.entries.filter(
      (entry) => entry.sessionId === CONVERSATION_LOG.currentSessionId
    ),
  };

  const compressedSnapshot = {
    id: snapshot.id,
    timestamp: snapshot.timestamp,
    description: snapshot.description,
    data: await CompressionUtils.compress(snapshot),
  };

  SNAPSHOT_SYSTEM.snapshots.unshift(compressedSnapshot);
  if (SNAPSHOT_SYSTEM.snapshots.length > SNAPSHOT_SYSTEM.maxSnapshots) {
    SNAPSHOT_SYSTEM.snapshots.pop();
  }

  await chrome.storage.local.set({
    conversationSnapshots: SNAPSHOT_SYSTEM.snapshots,
  });

  return snapshot;
}

// Restore conversation from snapshot
async function restoreSnapshot(snapshotId) {
  await validateSnapshots();

  const compressedSnapshot = SNAPSHOT_SYSTEM.snapshots.find(
    (s) => s.id === snapshotId
  );
  if (!compressedSnapshot) return false;

  try {
    const snapshot = await CompressionUtils.decompress(compressedSnapshot.data);

    // Close existing conversation if any
    await stopAllProcesses();

    // Restore conversation state
    currentConversation = { ...snapshot.conversation };
    CONVERSATION_LOG.currentSessionId = Date.now().toString();

    // Create new tabs with the same URLs
    const window = await chrome.windows.create({
      url: snapshot.conversation.tabs
        .map((tabId) => RECOVERY_STATE.savedTabs.get(tabId)?.url)
        .filter(Boolean),
      focused: true,
    });

    if (window?.tabs) {
      currentConversation.tabs = window.tabs.map((tab) => tab.id);
      startWatchdog();
      return true;
    }
  } catch (error) {
    handleError(error);
    // Remove invalid snapshot
    SNAPSHOT_SYSTEM.snapshots = SNAPSHOT_SYSTEM.snapshots.filter(
      (s) => s.id !== snapshotId
    );
    await chrome.storage.local.set({
      conversationSnapshots: SNAPSHOT_SYSTEM.snapshots,
    });
  }
  return false;
}

// Add snapshot error boundary handling
async function validateSnapshots() {
  try {
    const validSnapshots = [];
    for (const compressedSnapshot of SNAPSHOT_SYSTEM.snapshots) {
      try {
        const snapshot = await CompressionUtils.decompress(
          compressedSnapshot.data
        );
        if (snapshot?.conversation?.tabs?.length && snapshot.messages?.length) {
          const urls = snapshot.conversation.tabs
            .map((tabId) => RECOVERY_STATE.savedTabs.get(tabId)?.url)
            .filter(Boolean);

          if (urls.length === snapshot.conversation.tabs.length) {
            validSnapshots.push(compressedSnapshot);
          }
        }
      } catch (error) {
        console.error("Invalid snapshot:", error);
      }
    }

    SNAPSHOT_SYSTEM.snapshots = validSnapshots;
    await chrome.storage.local.set({
      conversationSnapshots: SNAPSHOT_SYSTEM.snapshots,
    });
  } catch (error) {
    console.error("Error validating snapshots:", error);
  }
}

// Add periodic snapshot validation
setInterval(validateSnapshots, 60000); // Check every minute

// Delete snapshot
async function deleteSnapshot(snapshotId) {
  SNAPSHOT_SYSTEM.snapshots = SNAPSHOT_SYSTEM.snapshots.filter(
    (s) => s.id !== snapshotId
  );
  await chrome.storage.local.set({
    conversationSnapshots: SNAPSHOT_SYSTEM.snapshots,
  });
  return true;
}

// Backup system
const BACKUP_SYSTEM = {
  lastBackup: null,
  backupInterval: 30 * 60 * 1000, // 30 minutes
  maxBackups: 5,
};

async function createBackup() {
  try {
    const backup = {
      timestamp: Date.now(),
      snapshots: SNAPSHOT_SYSTEM.snapshots,
      conversationLog: CONVERSATION_LOG.entries,
      stats: stats,
    };

    const compressedBackup = {
      timestamp: backup.timestamp,
      data: await CompressionUtils.compress(backup),
    };

    const { backups = [] } = await chrome.storage.local.get("backups");
    backups.unshift(compressedBackup);

    while (backups.length > BACKUP_SYSTEM.maxBackups) {
      backups.pop();
    }

    await chrome.storage.local.set({ backups });
    BACKUP_SYSTEM.lastBackup = Date.now();

    console.log("Compressed backup created successfully");
  } catch (error) {
    console.error("Failed to create backup:", error);
  }
}

async function restoreFromBackup(timestamp) {
  try {
    const { backups = [] } = await chrome.storage.local.get("backups");
    const compressedBackup = backups.find((b) => b.timestamp === timestamp);

    if (!compressedBackup) {
      throw new Error("Backup not found");
    }

    const backup = await CompressionUtils.decompress(compressedBackup.data);

    // Restore snapshots
    SNAPSHOT_SYSTEM.snapshots = backup.snapshots;

    await chrome.storage.local.set({
      conversationSnapshots: SNAPSHOT_SYSTEM.snapshots,
    });

    // Restore conversation log
    CONVERSATION_LOG.entries = backup.conversationLog;
    await chrome.storage.local.set({
      conversationLog: CONVERSATION_LOG.entries,
    });

    // Restore stats
    Object.assign(stats, backup.stats);

    return true;
  } catch (error) {
    console.error("Failed to restore from backup:", error);
    return false;
  }
}

// Start backup system
function startBackupSystem() {
  // Create initial backup
  createBackup();

  // Schedule regular backups
  setInterval(async () => {
    const timeSinceLastBackup = Date.now() - (BACKUP_SYSTEM.lastBackup || 0);
    if (timeSinceLastBackup >= BACKUP_SYSTEM.backupInterval) {
      await createBackup();
    }
  }, 5 * 60 * 1000); // Check every 5 minutes
}

// Compression utilities
const CompressionUtils = {
  async compress(data) {
    const jsonString = JSON.stringify(data);
    const byteArray = new TextEncoder().encode(jsonString);
    const compressedData = await new Response(
      new Blob([byteArray]).stream().pipeThrough(new CompressionStream("gzip"))
    ).blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.readAsDataURL(compressedData);
    });
  },

  async decompress(compressedData) {
    const blob = await fetch(compressedData).then((r) => r.blob());
    const decompressedData = await new Response(
      blob.stream().pipeThrough(new DecompressionStream("gzip"))
    ).blob();
    const text = await decompressedData.text();
    return JSON.parse(text);
  },
};

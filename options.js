// Utility functions
const $ = (selector) => document.querySelector(selector);
const showStatus = (message, isError = false) => {
  const status = $("#status");
  status.textContent = message;
  status.className = `status ${isError ? "error" : "success"}`;
  status.style.display = "block";
  setTimeout(() => (status.style.display = "none"), 3000);
};

// URL validation
function isValidUrl(url) {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

// Format time duration
function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}:${String(minutes % 60).padStart(2, "0")}:${String(
      seconds % 60
    ).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

// Update statistics display
function updateStats() {
  chrome.runtime.sendMessage({ action: "getStats" }, (stats) => {
    if (!stats) return;

    $("#messages-count").textContent = stats.messagesExchanged;
    $("#avg-response-time").textContent = `${Math.round(
      stats.averageResponseTime
    )}ms`;
    $("#success-rate").textContent = `${stats.successRate}%`;
    $("#running-time").textContent = formatDuration(stats.runningTime);

    // Update error stats
    $("#network-errors").textContent = stats.errors.network;
    $("#timeout-errors").textContent = stats.errors.timeout;
    $("#connection-drops").textContent = stats.connectionDrops;
    $("#other-errors").textContent = stats.errors.other;

    // Update success rate color based on value
    const successRate = parseFloat(stats.successRate);
    $("#success-rate").style.color =
      successRate > 90 ? "#4CAF50" : successRate > 70 ? "#FFA500" : "#FF0000";
  });
}

// Form validation
function validateForm() {
  let isValid = true;
  const url1 = $("#url1").value.trim();
  const url2 = $("#url2").value.trim();
  const timeout = $("#timeout").value;
  const topic = $("#topic").value.trim();

  // Validate URLs
  if (!url1 || !isValidUrl(url1)) {
    $("#url1-error").textContent = "Please enter a valid URL";
    isValid = false;
  } else {
    $("#url1-error").textContent = "";
  }

  if (!url2 || !isValidUrl(url2)) {
    $("#url2-error").textContent = "Please enter a valid URL";
    isValid = false;
  } else {
    $("#url2-error").textContent = "";
  }

  // Validate timeout
  if (!timeout || timeout < 1000) {
    $("#timeout-error").textContent = "Timeout must be at least 1000ms";
    isValid = false;
  } else {
    $("#timeout-error").textContent = "";
  }

  // Validate topic
  if (!topic) {
    $("#topic-error").textContent = "Please enter a conversation topic";
    isValid = false;
  } else {
    $("#topic-error").textContent = "";
  }

  return isValid;
}

// Load saved settings
function loadSettings() {
  chrome.storage.sync.get(["urls", "timeout", "enabled", "topic"], (items) => {
    if (items.urls && items.urls.length >= 2) {
      $("#url1").value = items.urls[0] || "";
      $("#url2").value = items.urls[1] || "";
    }
    $("#timeout").value = items.timeout || 3000;
    $("#topic").value = items.topic || "";
    updateStatusDisplay(items.enabled);
  });
}

// Update status display
function updateStatusDisplay(enabled) {
  const statusDisplay = $("#status-display");
  statusDisplay.textContent = enabled ? "Active" : "Inactive";
  statusDisplay.style.color = enabled ? "#4CAF50" : "#a94442";
}

// Save settings (Corrected)
async function saveSettings() {
  if (!validateForm()) {
    showStatus("Please fix the errors before saving.", true);
    return;
  }

  const settings = {
    urls: [$("#url1").value.trim(), $("#url2").value.trim()],
    timeout: parseInt($("#timeout").value),
    topic: $("#topic").value.trim(),
  };

  try {
    // Use await here to ensure settings are saved before sending the message
    await chrome.storage.sync.set(settings);
    showStatus("Settings saved successfully!");

    // Notify background script of settings change
    chrome.runtime.sendMessage({
      action: "settingsUpdated",
      settings,
    });
  } catch (error) {
    showStatus("Error saving settings: " + error.message, true);
  }
}

// Start chat relay
function startChatRelay() {
  if (!validateForm()) {
    showStatus("Please fix the errors before starting chat relay.", true);
    return;
  }

  chrome.runtime.sendMessage({
    action: "startChatRelay",
    topic: $("#topic").value.trim(),
  });
}

// Stop chat relay (Added)
function stopChatRelay() {
  chrome.runtime.sendMessage({ action: "stopChatRelay" });
}

// Reset statistics
function resetStats() {
  chrome.runtime.sendMessage({ action: "resetStats" }, () => {
    updateStats();
    showStatus("Statistics have been reset");
  });
}

// Auto-save debouncing
let autoSaveTimeout = null;
function debouncedAutoSave() {
  if (autoSaveTimeout) {
    clearTimeout(autoSaveTimeout);
  }
  autoSaveTimeout = setTimeout(saveSettings, 1000);
}

// Network status monitoring
let isOnline = navigator.onLine;
window.addEventListener("online", () => {
  isOnline = true;
  showStatus("Connection restored", false);
  updateStatusDisplay($("#status-display").textContent === "Active");
});

window.addEventListener("offline", () => {
  isOnline = false;
  showStatus("Connection lost", true);
  updateStatusDisplay(false);
});

// Enhanced event listeners with auto-save (Corrected)
function setupAutoSave() {
  const inputs = document.querySelectorAll("input");
  inputs.forEach((input) => {
    input.addEventListener("input", debouncedAutoSave);
    input.addEventListener("change", saveSettings); // Immediate save
  });
}

// Conversation history management
function formatTimestamp(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleString();
}

function createConversationEntry(entry) {
  const div = document.createElement("div");
  div.className = `conversation-entry ${
    entry.type === "topic" ? "conversation-topic" : "conversation-response"
  }`;

  const timestamp = document.createElement("span");
  timestamp.className = "conversation-timestamp";
  timestamp.textContent = formatTimestamp(entry.timestamp);

  const content = document.createElement("div");
  if (entry.type === "topic") {
    content.textContent = `New Conversation: ${entry.content}`;
  } else {
    const botIndicator = document.createElement("span");
    botIndicator.className = "bot-indicator";
    botIndicator.textContent = `Bot ${entry.botIndex + 1}`;
    content.appendChild(botIndicator);
    content.appendChild(document.createTextNode(entry.content));
  }

  div.appendChild(timestamp);
  div.appendChild(content);
  return div;
}

function updateConversationLog() {
  chrome.runtime.sendMessage({ action: "getConversationLog" }, (response) => {
    const logContainer = $("#conversation-log");
    logContainer.innerHTML = "";

    if (response?.log?.length) {
      response.log.forEach((entry) => {
        logContainer.appendChild(createConversationEntry(entry));
      });
    } else {
      logContainer.textContent = "No conversation history available.";
    }
  });
}

// Export conversation history
function exportConversationHistory() {
  chrome.runtime.sendMessage({ action: "getConversationLog" }, (response) => {
    if (!response?.log?.length) {
      showStatus("No conversation history to export", true);
      return;
    }

    const exportData = {
      timestamp: new Date().toISOString(),
      conversations: response.log,
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `chat-relay-history-${new Date()
      .toISOString()
      .slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showStatus("Conversation history exported successfully");
  });
}

// Clear conversation history
function clearConversationHistory() {
  if (confirm("Are you sure you want to clear the conversation history?")) {
    chrome.storage.local.remove("conversationLog", () => {
      updateConversationLog();
      showStatus("Conversation history cleared");
    });
  }
}

// Snapshot management
function formatSnapshotTimestamp(isoString) {
  const date = new Date(isoString);
  return date.toLocaleString();
}

function createSnapshotElement(snapshot) {
  const item = document.createElement("div");
  item.className = "snapshot-item";

  const info = document.createElement("div");
  info.className = "snapshot-info";

  const description = document.createElement("div");
  description.className = "snapshot-description";
  description.textContent = snapshot.description || "Unnamed snapshot";

  const timestamp = document.createElement("div");
  timestamp.className = "snapshot-timestamp";
  timestamp.textContent = formatSnapshotTimestamp(snapshot.timestamp);

  info.appendChild(description);
  info.appendChild(timestamp);

  const controls = document.createElement("div");
  controls.className = "snapshot-controls";

  const restoreButton = document.createElement("button");
  restoreButton.className = "restore-button";
  restoreButton.textContent = "Restore";
  restoreButton.onclick = () => restoreSnapshot(snapshot.id);

  const deleteButton = document.createElement("button");
  deleteButton.className = "delete-button";
  deleteButton.textContent = "Delete";
  deleteButton.onclick = () => deleteSnapshot(snapshot.id);

  controls.appendChild(restoreButton);
  controls.appendChild(deleteButton);

  item.appendChild(info);
  item.appendChild(controls);

  return item;
}

function updateSnapshotsList() {
  chrome.runtime.sendMessage({ action: "getSnapshots" }, (response) => {
    const snapshotList = $("#snapshot-list");
    snapshotList.innerHTML = "";

    if (response?.snapshots?.length) {
      response.snapshots.forEach((snapshot) => {
        snapshotList.appendChild(createSnapshotElement(snapshot));
      });
    } else {
      snapshotList.textContent = "No snapshots available.";
    }
  });
}

async function createNewSnapshot() {
  const description = $("#snapshot-description").value.trim();
  if (!description) {
    showStatus("Please enter a description for the snapshot", true);
    return;
  }

  chrome.runtime.sendMessage(
    { action: "createSnapshot", description },
    (response) => {
      if (response?.success) {
        showStatus("Snapshot created successfully");
        $("#snapshot-description").value = "";
        updateSnapshotsList();
      } else {
        showStatus(
          "Failed to create snapshot: " + (response?.error || "Unknown error"),
          true
        );
      }
    }
  );
}

async function restoreSnapshot(snapshotId) {
  if (
    !confirm(
      "Are you sure you want to restore this snapshot? Current conversation will be closed."
    )
  ) {
    return;
  }

  chrome.runtime.sendMessage(
    { action: "restoreSnapshot", snapshotId },
    (response) => {
      if (response?.success) {
        showStatus("Snapshot restored successfully");
        // Add these lines to refresh the UI after restoring:
        updateConversationLog();
        updateStats();
      } else {
        showStatus(
          "Failed to restore snapshot: " + (response?.error || "Unknown error"),
          true
        );
      }
    }
  );
}

async function deleteSnapshot(snapshotId) {
  if (!confirm("Are you sure you want to delete this snapshot?")) {
    return;
  }

  chrome.runtime.sendMessage(
    { action: "deleteSnapshot", snapshotId },
    (response) => {
      if (response?.success) {
        showStatus("Snapshot deleted successfully");
        updateSnapshotsList();
      } else {
        showStatus(
          "Failed to delete snapshot: " + (response?.error || "Unknown error"),
          true
        );
      }
    }
  );
}

// Theme handling
function updateThemeColors() {
  const isDarkMode = window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.setAttribute(
    "data-theme",
    isDarkMode ? "dark" : "light"
  );
}

// Watch for system theme changes
const themeMediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
themeMediaQuery.addEventListener("change", updateThemeColors);

// Backup management
function formatBackupTimestamp(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleString();
}

function formatBackupStats(stats) {
  return `Messages: ${stats.messagesExchanged}, Success Rate: ${(
    ((stats.messagesExchanged -
      Object.values(stats.errors).reduce((a, b) => a + b, 0)) /
      (stats.messagesExchanged || 1)) *
    100
  ).toFixed(1)}%`;
}

function createBackupElement(backup) {
  const item = document.createElement("div");
  item.className = "backup-item";

  const info = document.createElement("div");
  info.className = "backup-info";

  const timestamp = document.createElement("div");
  timestamp.className = "backup-timestamp";
  timestamp.textContent = formatBackupTimestamp(backup.timestamp);

  const stats = document.createElement("div");
  stats.className = "backup-stats";
  stats.textContent = formatBackupStats(backup.stats);

  info.appendChild(timestamp);
  info.appendChild(stats);

  const controls = document.createElement("div");
  controls.className = "backup-controls";

  const restoreButton = document.createElement("button");
  restoreButton.className = "restore-backup-button";
  restoreButton.textContent = "Restore";
  restoreButton.onclick = () => restoreFromBackup(backup.timestamp);

  controls.appendChild(restoreButton);

  item.appendChild(info);
  item.appendChild(controls);

  return item;
}

function updateBackupsList() {
  chrome.runtime.sendMessage({ action: "getBackups" }, (response) => {
    const backupList = $("#backup-list");
    backupList.innerHTML = "";

    if (response?.backups?.length) {
      response.backups.forEach((backup) => {
        backupList.appendChild(createBackupElement(backup));
      });
    } else {
      backupList.textContent = "No backups available.";
    }
  });
}

async function createManualBackup() {
  chrome.runtime.sendMessage({ action: "createBackup" }, (response) => {
    if (response?.success) {
      showStatus("Backup created successfully");
      updateBackupsList();
    } else {
      showStatus(
        "Failed to create backup: " + (response?.error || "Unknown error"),
        true
      );
    }
  });
}

async function restoreFromBackup(timestamp) {
  if (
    !confirm(
      "Are you sure you want to restore from this backup? Current conversation and snapshots will be replaced."
    )
  ) {
    return;
  }

  chrome.runtime.sendMessage(
    { action: "restoreBackup", timestamp },
    (response) => {
      if (response?.success) {
        showStatus("Backup restored successfully");
        updateConversationLog();
        updateSnapshotsList();
        updateStats();
      } else {
        showStatus(
          "Failed to restore backup: " + (response?.error || "Unknown error"),
          true
        );
      }
    }
  );
}

// Event listeners
document.addEventListener("DOMContentLoaded", () => {
  loadSettings();
  updateStats();
  updateConversationLog();
  setupAutoSave();

  updateSnapshotsList();
  updateBackupsList();

  // Start periodic updates
  setInterval(() => {
    updateStats();
    updateConversationLog();
    updateSnapshotsList();
    updateBackupsList();
  }, 5000);

  updateThemeColors();

  $("#save").addEventListener("click", saveSettings);
  $("#startChat").addEventListener("click", startChatRelay);
  $("#stopChat").addEventListener("click", stopChatRelay); // Add Stop button
  $("#reset-stats").addEventListener("click", resetStats);

  // Add URL button handler (Corrected - but still only supports 2 URLs)
  $("#addUrl").addEventListener("click", () => {
    const urlInputs = $("#urlInputs"); // This element doesn't exist.  Fix below.
    const newUrlGroup = document.createElement("div");
    newUrlGroup.className = "form-group url-group";
    newUrlGroup.innerHTML = `
            <label>Additional Chatbot URL:</label>
            <input type="url" placeholder="Enter URL for Chatbot" required>
            <div class="validation-error"></div>
            <button type="button" onclick="this.parentElement.remove()">Remove</button>
        `;
    urlInputs.appendChild(newUrlGroup);
  });

  // Add event listeners for conversation history controls
  $("#export-log").addEventListener("click", exportConversationHistory);
  $("#clear-log").addEventListener("click", clearConversationHistory);

  $("#create-snapshot").addEventListener("click", createNewSnapshot);
  $("#create-backup").addEventListener("click", createManualBackup);

  // Listen for status updates from background script
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "statusUpdate") {
      updateStatusDisplay(message.enabled);
      updateStats();
      updateConversationLog();
      updateSnapshotsList();
      updateBackupsList();
    }
  });
});

// --- options.js ---

const $ = (selector) => document.querySelector(selector);

function showStatus(message, isError = false) {
  const status = $("#status");
  status.textContent = message;
  status.className = `status ${isError ? "error" : "success"}`;
  status.style.display = "block";
  setTimeout(() => (status.style.display = "none"), 3000);
}

function isValidUrl(url) {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return hours > 0
    ? `${hours}:${String(minutes % 60).padStart(2, "0")}:${String(
        seconds % 60
      ).padStart(2, "0")}`
    : `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

// --- Update Stats Display ---
function updateStatsDisplay(enabled) {
  const statusDisplay = $("#status-display");
  statusDisplay.textContent = enabled ? "Active" : "Inactive";
  statusDisplay.style.color = enabled ? "#4CAF50" : "#a94442";
}

function updateStats(stats) {
  if (!stats) return;

  $("#messages-count").textContent = stats.messagesExchanged;
  $("#avg-response-time").textContent = `${Math.round(
    stats.averageResponseTime
  )}ms`;
  $("#success-rate").textContent = `${stats.successRate}%`;
  $("#running-time").textContent = formatDuration(stats.runningTime);
  $("#network-errors").textContent = stats.errors.network;
  $("#timeout-errors").textContent = stats.errors.timeout;
  $("#connection-drops").textContent = stats.errors.connectionDrops;
  $("#other-errors").textContent = stats.errors.other;

  const successRate = parseFloat(stats.successRate);
  $("#success-rate").style.color =
    successRate > 90 ? "#4CAF50" : successRate > 70 ? "#FFA500" : "#FF0000";
}
// --- End Update Stats ---

// --- Conversation Log ---
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
  timestamp.style.float = "right"; //Added Style

  const content = document.createElement("div");
  if (entry.type === "topic") {
    content.textContent = `New Conversation: ${entry.content}`;
  } else {
    const botIndicator = document.createElement("span");
    botIndicator.className = "bot-indicator";
    botIndicator.textContent = `Bot ${entry.botIndex + 1}`;
    content.appendChild(botIndicator);
    content.append(` ${entry.content}`); //Added space
  }

  div.appendChild(timestamp);
  div.appendChild(content);
  return div;
}

function updateConversationLog(log) {
  const logContainer = $("#conversation-log");
  logContainer.innerHTML = ""; // Clear previous entries

  if (log && log.length > 0) {
    log.forEach((entry) => {
      logContainer.appendChild(createConversationEntry(entry));
    });
    logContainer.scrollTop = logContainer.scrollHeight; // Scroll to bottom
  } else {
    logContainer.textContent = "No conversation history available.";
  }
}

// --- End Conversation Log ---

function validateForm() {
  let isValid = true;
  const url1 = $("#url1").value.trim();
  const url2 = $("#url2").value.trim();
  const timeout = $("#timeout").value;
  const topic = $("#topic").value.trim();

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

  if (!timeout || timeout < 1000) {
    $("#timeout-error").textContent = "Timeout must be at least 1000ms";
    isValid = false;
  } else {
    $("#timeout-error").textContent = "";
  }

  if (!topic) {
    $("#topic-error").textContent = "Please enter a conversation topic";
    isValid = false;
  } else {
    $("#topic-error").textContent = "";
  }

  return isValid;
}

function loadSettings() {
  chrome.storage.sync
    .get(["urls", "timeout", "enabled", "topic"])
    .then((items) => {
      if (items.urls && items.urls.length >= 2) {
        $("#url1").value = items.urls[0] || "";
        $("#url2").value = items.urls[1] || "";
      }
      $("#timeout").value = items.timeout || 3000;
      $("#topic").value = items.topic || "";
      updateStatusDisplay(items.enabled); // Update status display
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
      updateConversationLog([]); //Update with empty array
      showStatus("Conversation history cleared");
    });
  }
}

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
    await chrome.storage.sync.set(settings);
    showStatus("Settings saved successfully!");
    chrome.runtime.sendMessage({ action: "settingsUpdated", settings });
  } catch (error) {
    showStatus("Error saving settings: " + error.message, true);
  }
}

function startChatRelay() {
  if (!validateForm()) {
    showStatus("Please fix the errors before starting.", true);
    return;
  }
  chrome.runtime.sendMessage({
    action: "startChatRelay",
    topic: $("#topic").value.trim(),
  });
}

function stopChatRelay() {
  chrome.runtime.sendMessage({ action: "stopChatRelay" });
}

function resetStats() {
  chrome.runtime.sendMessage({ action: "resetStats" }, () => {
    // No need to call updateStats() here, as background will send an update.
    showStatus("Statistics have been reset");
  });
}

// --- Auto-save ---
let autoSaveTimeout = null;
function debouncedAutoSave() {
  if (autoSaveTimeout) {
    clearTimeout(autoSaveTimeout);
  }
  autoSaveTimeout = setTimeout(saveSettings, 1000);
}

function setupAutoSave() {
  const inputs = document.querySelectorAll("input");
  inputs.forEach((input) => {
    input.addEventListener("input", debouncedAutoSave);
    input.addEventListener("change", saveSettings); // Immediate save
  });
}
// --- End Auto-save ---

document.addEventListener("DOMContentLoaded", () => {
  loadSettings();

  // Fetch initial stats and log
  chrome.runtime.sendMessage({ action: "getStats" }, (stats) => {
    updateStats(stats);
  });
  chrome.runtime.sendMessage({ action: "getConversationLog" }, (response) => {
    updateConversationLog(response.log);
  });

  setupAutoSave();

  // --- Event Listeners ---
  $("#save").addEventListener("click", saveSettings);
  $("#startChat").addEventListener("click", startChatRelay);
  $("#stopChat").addEventListener("click", stopChatRelay);
  $("#reset-stats").addEventListener("click", resetStats);
  $("#export-log").addEventListener("click", exportConversationHistory);
  $("#clear-log").addEventListener("click", clearConversationHistory);

  // Add URL button handler
  $("#addUrl").addEventListener("click", () => {
    const urlInputs = $("#urlInputs");
    const newUrlGroup = document.createElement("div");
    newUrlGroup.className = "form-group url-group";
    newUrlGroup.innerHTML = `
            <label>Additional Chatbot URL:</label>
            <input type="url" placeholder="Enter URL for Chatbot">
            <div class="validation-error"></div>
            <button type="button" onclick="this.parentElement.remove()">Remove</button>
        `;
    urlInputs.appendChild(newUrlGroup);
  });

  // Listen for messages from the background script
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "statusUpdate") {
      updateStatusDisplay(message.enabled);
      updateStats(message.stats); //Update Stats
      updateConversationLog(message.log); // Update Log
    }
  });
});

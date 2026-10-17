"use strict";

// Read-only lookups: only the video ID is sent, and only when the user clicks "Show dislikes?". No votes, user IDs,
// cookies, or referrer leave the browser.
const API_URL = "https://returnyoutubedislikeapi.com/votes";
const ATTRIBUTION = "Estimate from returnyoutubedislike.com";
const CACHE_PREFIX = "votes:";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const DISLIKE_BUTTON_SELECTOR = "ytd-watch-metadata dislike-button-view-model button";
// YouTube's classes for an icon-only button and for one with an icon followed by text (like the like button).
const ICON_ONLY_CLASS = "ytSpecButtonShapeNextIconButton";
const ICON_LEADING_CLASS = "ytSpecButtonShapeNextIconLeading";
const TEXT_CLASSES = ["ytSpecButtonShapeNextButtonTextContent", "ytSpecButtonShapeNextElevatedContent"];
const DISLIKE_COUNT_SUFFIX = / \([^()]* dislikes, estimated\)$/;

const compactFormat = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const fullFormat = new Intl.NumberFormat();

// The label lives inside YouTube's dislike button. Until the count is loaded it acts as its own control, so clicking it
// looks up the count instead of disliking the video. Once loaded, it is plain text like the like count.
const label = createLabel();
let currentVideoId = null;
let isLoading = false;
let updateScheduled = false;

function createLabel() {
  const element = document.createElement("span");
  element.classList.add("ytd-dislikes-label", ...TEXT_CLASSES);
  element.setAttribute("role", "button");
  element.tabIndex = 0;
  return element;
}

function isLabelActive() {
  return label.dataset.state !== "loaded" && !isLoading;
}

function render(text, title) {
  label.textContent = text;
  label.title = title;
  label.setAttribute("aria-disabled", String(isLoading));
}

function renderIdle() {
  label.dataset.state = "idle";
  render("Show dislikes?", "Look up the dislike count for this video");
  updateDislikeButtonLabel();
}

function renderVotes(votes) {
  label.dataset.state = "loaded";
  const dislikes = fullFormat.format(votes.dislikes);
  render(compactFormat.format(votes.dislikes), `${dislikes} dislikes, ${fullFormat.format(votes.likes)} likes. ${ATTRIBUTION}.`);
  label.removeAttribute("role");
  label.removeAttribute("tabindex");
  label.removeAttribute("aria-disabled");
  updateDislikeButtonLabel();
}

// Adds the count to the dislike button's accessible name, keeping YouTube's own (possibly localized) text.
function updateDislikeButtonLabel() {
  const button = label.parentElement;
  if (!button?.ariaLabel) {
    return;
  }
  const base = button.ariaLabel.replace(DISLIKE_COUNT_SUFFIX, "");
  const wanted = label.dataset.state === "loaded" ? `${base} (${label.textContent} dislikes, estimated)` : base;
  if (button.ariaLabel !== wanted) {
    button.ariaLabel = wanted;
  }
}

function getVideoId() {
  if (location.pathname !== "/watch") {
    return null;
  }
  const videoId = new URLSearchParams(location.search).get("v");
  return videoId && VIDEO_ID_PATTERN.test(videoId) ? videoId : null;
}

async function readCache(videoId) {
  const key = CACHE_PREFIX + videoId;
  const { [key]: entry } = await browser.storage.local.get(key);
  return entry && Date.now() - entry.fetchedAt < CACHE_TTL_MS ? entry : null;
}

async function writeCache(videoId, votes) {
  const now = Date.now();
  const entries = await browser.storage.local.get(null);
  const expiredKeys = Object.keys(entries).filter(
    (key) => key.startsWith(CACHE_PREFIX) && now - entries[key].fetchedAt >= CACHE_TTL_MS,
  );
  await browser.storage.local.remove(expiredKeys);
  await browser.storage.local.set({ [CACHE_PREFIX + videoId]: { ...votes, fetchedAt: now } });
}

async function fetchVotes(videoId) {
  const url = `${API_URL}?videoId=${encodeURIComponent(videoId)}`;
  const response = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
  if (response.status === 404) {
    throw new Error("No data for this video");
  }
  if (response.status === 429) {
    throw new Error("Too many requests. Try again later");
  }
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }
  const { likes, dislikes } = await response.json();
  if (!Number.isFinite(likes) || !Number.isFinite(dislikes)) {
    throw new Error("Unexpected response");
  }
  return { likes, dislikes };
}

async function showDislikes() {
  const videoId = currentVideoId;
  if (!videoId || !isLabelActive()) {
    return;
  }
  isLoading = true;
  render("Loading…", "Looking up dislikes");
  try {
    let votes = await readCache(videoId);
    if (!votes) {
      votes = await fetchVotes(videoId);
      await writeCache(videoId, votes);
    }
    if (videoId === currentVideoId) {
      isLoading = false;
      renderVotes(votes);
    }
  } catch (error) {
    if (videoId === currentVideoId) {
      isLoading = false;
      label.dataset.state = "error";
      render("Retry?", `${error.message}. Click to retry.`);
    }
  }
}

// YouTube covers the button with a touch feedback overlay that receives pointer events, so hits are checked by position.
function isOnLabel(event) {
  if (event.target === label) {
    return true;
  }
  if (!("clientX" in event) || !label.parentElement?.contains(event.target)) {
    return false;
  }
  const rect = label.getBoundingClientRect();
  return (
    event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom
  );
}

// Listening on window in the capture phase runs before YouTube's own handlers, so the click never reaches them.
function interceptLabelEvent(event) {
  if (label.dataset.state === "loaded" || !isOnLabel(event)) {
    return;
  }
  if (event.type === "keydown" && event.key !== "Enter" && event.key !== " ") {
    return;
  }
  event.preventDefault();
  event.stopImmediatePropagation();
  if (event.type === "click" || event.type === "keydown") {
    showDislikes();
  }
}

async function onVideoChange(videoId) {
  currentVideoId = videoId;
  isLoading = false;
  label.setAttribute("role", "button");
  label.tabIndex = 0;
  renderIdle();
  // Cached counts are shown right away, since showing them sends nothing over the network.
  const cached = await readCache(videoId);
  if (cached && videoId === currentVideoId && label.dataset.state === "idle") {
    renderVotes(cached);
  }
}

function attachLabel(button) {
  if (label.parentElement !== button) {
    const icon = button.querySelector(".ytSpecButtonShapeNextIcon");
    if (icon) {
      icon.after(label);
    } else {
      button.prepend(label);
    }
  }
  if (button.classList.contains(ICON_ONLY_CLASS)) {
    button.classList.replace(ICON_ONLY_CLASS, ICON_LEADING_CLASS);
  }
  updateDislikeButtonLabel();
}

function detachLabel() {
  const button = label.parentElement;
  if (!button) {
    return;
  }
  label.remove();
  button.classList.replace(ICON_LEADING_CLASS, ICON_ONLY_CLASS);
  if (button.ariaLabel) {
    button.ariaLabel = button.ariaLabel.replace(DISLIKE_COUNT_SUFFIX, "");
  }
}

function update() {
  updateScheduled = false;
  const videoId = getVideoId();
  if (!videoId) {
    detachLabel();
    currentVideoId = null;
    return;
  }
  if (videoId !== currentVideoId) {
    onVideoChange(videoId);
  }
  const button = document.querySelector(DISLIKE_BUTTON_SELECTOR);
  if (button) {
    attachLabel(button);
  }
}

function scheduleUpdate() {
  if (!updateScheduled) {
    updateScheduled = true;
    requestAnimationFrame(update);
  }
}

for (const type of ["click", "keydown", "pointerdown", "mousedown", "pointerup", "mouseup"]) {
  window.addEventListener(type, interceptLabelEvent, true);
}

// YouTube is a single-page app that re-renders the action bar often, so keep re-attaching the label.
new MutationObserver(scheduleUpdate).observe(document.body, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["class", "aria-label"],
});
document.addEventListener("yt-navigate-finish", scheduleUpdate);
scheduleUpdate();

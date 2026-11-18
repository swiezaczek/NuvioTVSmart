import { Router } from "../../navigation/routerState.js";
import { ScreenUtils } from "../../navigation/screen.js";
import { catalogRepository } from "../../../data/repository/catalogRepository.js";
import { watchedItemsRepository } from "../../../data/repository/watchedItemsRepository.js";
import { watchedTitleStateRepository } from "../../../data/repository/watchedTitleStateRepository.js";
import { Environment } from "../../../platform/environment.js";
import { LayoutPreferences } from "../../../data/local/layoutPreferences.js";
import { I18n } from "../../../i18n/index.js";
import { filterReleasedItems } from "../../../core/util/releaseInfoUtils.js";
import { mergeCatalogPage } from "../../../core/util/catalogPagination.js";
import { focusWithoutAutoScroll } from "../../components/sidebarNavigation.js";
import {
  posterItemFromNode,
  PosterOptionsDialogController
} from "../../components/posterOptionsMenu.js";
import {
  buildWatchedTitleIdSet,
  isTitleItemWatched,
  renderTitleWatchedBadge
} from "../../components/watchedTitleBadge.js";
import { renderLoadingIndicator } from "../../components/loadingIndicator.js";

import { createCatalogSeeAllScreenMethods01 } from "./catalogSeeAllScreenMethods-01-get-route-state-key.js";
import { createCatalogSeeAllScreenMethods02 } from "./catalogSeeAllScreenMethods-02-handle-grid-dpad.js";
import { createCatalogSeeAllScreenMethods03 } from "./catalogSeeAllScreenMethods-03-on-key-down.js";

export {
  Router,
  ScreenUtils,
  catalogRepository,
  watchedItemsRepository,
  watchedTitleStateRepository,
  Environment,
  LayoutPreferences,
  I18n,
  filterReleasedItems,
  mergeCatalogPage,
  focusWithoutAutoScroll,
  posterItemFromNode,
  PosterOptionsDialogController,
  buildWatchedTitleIdSet,
  isTitleItemWatched,
  renderTitleWatchedBadge,
  renderLoadingIndicator,
  POSTER_HOLD_DELAY_MS,
  isBackEvent,
  escapeHtml,
  t,
  extractReleaseYear,
  groupNodesByOffsetTop,
  setContainerScrollTop,
  scrollNodeIntoContainerView
};
const POSTER_HOLD_DELAY_MS = 650;

function isBackEvent(event) {
  return Environment.isBackEvent(event);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function t(key, params = {}, fallback = key) {
  return I18n.t(key, params, { fallback });
}

function extractReleaseYear(item = {}) {
  const candidates = [
    item?.released,
    item?.releaseDate,
    item?.release_date,
    item?.releaseInfo,
    item?.year
  ].filter(Boolean);

  for (const value of candidates) {
    const match = String(value).match(/\b(19|20)\d{2}\b/);
    if (match) {
      return match[0];
    }
  }

  return "";
}

function groupNodesIntoTopBuckets(nodes = []) {
  const grouped = [];
  nodes.forEach((node) => {
    const top = Math.round(node.offsetTop);
    const bucket = grouped.find((entry) => Math.abs(entry.top - top) <= 6);
    if (bucket) {
      bucket.nodes.push(node);
      return;
    }
    grouped.push({ top, nodes: [node] });
  });
  grouped.sort((left, right) => left.top - right.top);
  return grouped;
}

function groupNodesByOffsetTop(nodes = [], { cache = null, containerClientWidth = null } = {}) {
  const list = Array.isArray(nodes) ? nodes : [];
  const count = list.length;
  const width = containerClientWidth == null ? null : Number(containerClientWidth);
  if (!cache || typeof cache !== "object") {
    return groupNodesIntoTopBuckets(list).map((entry) => entry.nodes);
  }
  if (!count) {
    cache.cardCount = 0;
    cache.containerClientWidth = width;
    cache.firstNode = null;
    cache.lastNode = null;
    cache.lastRowTop = null;
    cache.rows = [];
    return cache.rows;
  }
  if (
    Array.isArray(cache.rows) &&
    cache.cardCount === count &&
    cache.containerClientWidth === width &&
    cache.firstNode === list[0] &&
    cache.lastNode === list[count - 1]
  ) {
    return cache.rows;
  }
  if (
    Array.isArray(cache.rows) &&
    cache.cardCount > 0 &&
    count > cache.cardCount &&
    cache.containerClientWidth === width &&
    cache.firstNode === list[0] &&
    cache.lastNode === list[cache.cardCount - 1] &&
    Number.isFinite(cache.lastRowTop)
  ) {
    const tailBuckets = groupNodesIntoTopBuckets(list.slice(cache.cardCount));
    if (tailBuckets.length && tailBuckets[0].top >= cache.lastRowTop - 6) {
      let startBucket = 0;
      if (Math.abs(tailBuckets[0].top - cache.lastRowTop) <= 6 && cache.rows.length) {
        cache.rows[cache.rows.length - 1].push(...tailBuckets[0].nodes);
        startBucket = 1;
      }
      for (let i = startBucket; i < tailBuckets.length; i += 1) {
        cache.rows.push(tailBuckets[i].nodes);
      }
      cache.cardCount = count;
      cache.lastNode = list[count - 1];
      cache.lastRowTop = tailBuckets[tailBuckets.length - 1].top;
      return cache.rows;
    }
  }
  const buckets = groupNodesIntoTopBuckets(list);
  cache.cardCount = count;
  cache.containerClientWidth = width;
  cache.firstNode = list[0];
  cache.lastNode = list[count - 1];
  cache.lastRowTop = buckets.length ? buckets[buckets.length - 1].top : null;
  cache.rows = buckets.map((entry) => entry.nodes);
  return cache.rows;
}

function setContainerScrollTop(container, top, behavior = "auto") {
  if (!(container instanceof HTMLElement)) {
    return 0;
  }
  const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
  const resolvedTop = Math.max(0, Math.min(maxScrollTop, Number(top || 0)));
  if (behavior === "smooth") {
    if (typeof container.scrollTo === "function") {
      container.scrollTo({ top: resolvedTop, behavior: "smooth" });
    } else {
      container.scrollTop = resolvedTop;
    }
    return resolvedTop;
  }

  const previousBehavior = container.style.scrollBehavior;
  container.style.scrollBehavior = "auto";
  container.scrollTop = resolvedTop;
  void container.offsetHeight;
  container.style.scrollBehavior = previousBehavior;
  return resolvedTop;
}

function scrollNodeIntoContainerView(
  node,
  container,
  { center = false, padding = 18, behavior = "smooth" } = {}
) {
  if (!(node instanceof HTMLElement) || !(container instanceof HTMLElement)) {
    return null;
  }
  const itemTop = node.offsetTop;
  const itemBottom = itemTop + node.offsetHeight;
  const currentTop = container.scrollTop;
  const viewTop = currentTop + padding;
  const viewBottom = currentTop + container.clientHeight - padding;
  let nextScrollTop = currentTop;

  if (center) {
    nextScrollTop = itemTop - (container.clientHeight - node.offsetHeight) / 2;
  } else if (itemTop < viewTop) {
    nextScrollTop = itemTop - padding;
  } else if (itemBottom > viewBottom) {
    nextScrollTop = itemBottom - container.clientHeight + padding;
  }
  const resolvedTop = Math.max(0, nextScrollTop);
  if (Math.abs(resolvedTop - currentTop) <= 1) {
    return resolvedTop;
  }
  if (behavior === "smooth") {
    setContainerScrollTop(container, resolvedTop, "smooth");
  } else {
    setContainerScrollTop(container, resolvedTop, "auto");
  }
  return resolvedTop;
}

export const CatalogSeeAllScreen = {
  ...createCatalogSeeAllScreenMethods01(),
  ...createCatalogSeeAllScreenMethods02(),
  ...createCatalogSeeAllScreenMethods03()
};

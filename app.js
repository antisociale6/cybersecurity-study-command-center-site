(() => {
  "use strict";

  const CONFIG_PATH = document.documentElement.dataset.configPath || "site-config.json";
  const CONFIG_URL = new URL(CONFIG_PATH, document.baseURI);
  const MAX_VALUE_LENGTH = 80;
  const SAFE_CAMPAIGN_VALUE = /^[A-Za-z0-9._~-]+$/;
  const UTM_KEYS = [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
  ];

  function cleanValue(value) {
    if (typeof value !== "string") {
      return "";
    }
    const cleaned = value.trim();
    if (!cleaned || cleaned.length > MAX_VALUE_LENGTH || !SAFE_CAMPAIGN_VALUE.test(cleaned)) {
      return "";
    }
    return cleaned;
  }

  function currentUtmValues() {
    const params = new URLSearchParams(window.location.search);
    const values = {};
    for (const key of UTM_KEYS) {
      const dataName = key.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase());
      const defaultValue = document.documentElement.dataset[`default${dataName[0].toUpperCase()}${dataName.slice(1)}`];
      // The checked-in build chooses utm_content so inbound links cannot
      // overwrite the exact variant identity recorded by Gumroad.
      const inboundValue = key === "utm_content" ? "" : cleanValue(params.get(key));
      const value = inboundValue || cleanValue(defaultValue);
      if (value) {
        values[key] = value;
      }
    }
    return Object.freeze(values);
  }

  // Attribution lives only in memory for this page view. It is never persisted.
  const utmValues = currentUtmValues();

  function isPlaceholder(value) {
    return /^__SET_[A-Z0-9_]+__$/.test(value);
  }

  function isGumroadHost(hostname) {
    const normalized = hostname.toLowerCase().replace(/\.$/, "");
    return normalized === "gumroad.com" || normalized.endsWith(".gumroad.com");
  }

  function isGumroadProductUrl(destination) {
    return (
      destination.protocol === "https:" &&
      isGumroadHost(destination.hostname) &&
      destination.pathname.replace(/^\/+|\/+$/g, "").length > 0
    );
  }

  function validatedDestination(rawValue, type) {
    if (typeof rawValue !== "string" || !rawValue.trim() || isPlaceholder(rawValue)) {
      return null;
    }

    try {
      const destination = new URL(rawValue, CONFIG_URL);
      const isSameOrigin = destination.origin === window.location.origin;
      const isGumroad = isGumroadProductUrl(destination);

      if (type === "checkout" && !isGumroad) {
        return null;
      }
      if (type === "lead_magnet" && !isSameOrigin && !isGumroad) {
        return null;
      }
      return destination;
    } catch (_error) {
      return null;
    }
  }

  function destinationWithUtm(destination) {
    const result = new URL(destination.href);
    if (!isGumroadProductUrl(result)) {
      return result.href;
    }
    for (const key of UTM_KEYS) {
      const value = utmValues[key];
      if (value) {
        result.searchParams.set(key, value);
      }
    }
    return result.href;
  }

  function configureLinks(type, rawValue) {
    const destination = validatedDestination(rawValue, type);
    const links = document.querySelectorAll(`[data-funnel-link="${type}"]`);

    for (const link of links) {
      if (!destination) {
        // A disabled link must not inherit the current page query string.
        // Removing the destination also keeps it out of keyboard navigation.
        link.removeAttribute("href");
        link.removeAttribute("download");
        delete link.dataset.baseDestination;
        link.setAttribute("aria-disabled", "true");
        continue;
      }

      link.href = destination.href;
      link.dataset.baseDestination = destination.href;
      link.removeAttribute("aria-disabled");
      if (type === "lead_magnet" && destination.origin === window.location.origin) {
        link.setAttribute("download", "");
      }
    }
    return Boolean(destination);
  }

  function configureClickSafety() {
    const links = document.querySelectorAll("[data-funnel-link]");
    for (const link of links) {
      link.addEventListener("click", (event) => {
        if (link.getAttribute("aria-disabled") === "true") {
          event.preventDefault();
          return;
        }

        const baseDestination = link.dataset.baseDestination;
        if (!baseDestination) {
          event.preventDefault();
          return;
        }

        // The strict UTM allowlist is appended only to HTTPS Gumroad links.
        link.href = destinationWithUtm(new URL(baseDestination));
      });
    }
  }

  async function loadConfig() {
    const status = document.getElementById("link-status");
    try {
      const response = await window.fetch(CONFIG_URL, {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const config = await response.json();
      if (config.schema_version !== 1) {
        throw new Error("Unsupported configuration schema");
      }

      const leadReady = configureLinks("lead_magnet", config.lead_magnet_url);
      const checkoutReady = configureLinks("checkout", config.checkout_url);
      if (status) {
        if (leadReady && checkoutReady) {
          status.textContent = "Download and checkout links are ready.";
        } else if (leadReady) {
          status.textContent = "Preview download ready. Checkout awaits live publication.";
        } else {
          status.textContent = "Links are unavailable until reviewed configuration is supplied.";
        }
      }
    } catch (_error) {
      if (status) {
        status.textContent = "Links are disabled because the local configuration could not be verified.";
      }
    }
  }

  configureClickSafety();
  loadConfig();
})();

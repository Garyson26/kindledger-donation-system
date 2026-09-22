/**
 * =============================================================================
 * Branding at runtime (SPEC-5 package 5.4)
 * =============================================================================
 * Fetches `GET /api/branding` once and makes it available to the app, and sets
 * the admin-configured colours as CSS custom properties on the root element.
 *
 * -----------------------------------------------------------------------------
 * WHY THE COLOURS ARE SET HERE AND NOT BUILT IN
 * -----------------------------------------------------------------------------
 * `index.css` declares the DEFAULTS - the existing palette, unchanged. This
 * overrides them only when an admin has actually configured a colour, so:
 *
 *   - a fresh installation renders exactly as the site did before this package;
 *   - a configured one changes on the next page load, with **no rebuild**,
 *     which is the whole point of the whitelabel phase. An NGO does not run a
 *     frontend build.
 *
 * -----------------------------------------------------------------------------
 * A FAILED FETCH IS NOT AN ERROR STATE
 * -----------------------------------------------------------------------------
 * If branding cannot be loaded the app renders with the defaults. The donor
 * site must not break because a settings row is unreachable - the endpoint is
 * unauthenticated and read-only, and there is nothing a donor can do about it.
 *
 * The children render immediately either way; nothing waits on this.
 * =============================================================================
 */

import React, { createContext, useContext, useEffect, useState } from "react";
import { brandingAPI } from "../utils/api";

/**
 * The defaults match `index.css`, so a consumer reading this before the fetch
 * resolves sees the same values the stylesheet is already using.
 *
 * `organisationName` is EMPTY rather than any particular charity's name. This
 * is a whitelabel product: shipping one NGO's name as the built-in default
 * would put it on every other NGO's site for the moment before the fetch
 * resolves, and SPEC-5 section 10 requires no hardcoded name to remain.
 *
 * Empty renders as nothing, which is better than briefly rendering the wrong
 * organisation.
 */
const DEFAULTS = {
  organisationName: "",
  logoPath: null,
  logoMime: null,
  faviconPath: null,
  primaryColour: null,
  secondaryColour: null,
  supportEmail: null,
  websiteUrl: null,
  footerText: null,
  defaultCurrency: "INR",
};

const BrandingContext = createContext(DEFAULTS);

/** Six hex digits, the same rule the API and the CHECK constraint enforce. */
const HEX = /^#[0-9A-Fa-f]{6}$/;

export function BrandingProvider({ children }) {
  const [branding, setBranding] = useState(DEFAULTS);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, ok } = await brandingAPI.get();
      if (cancelled || !ok || !data) return;
      setBranding({ ...DEFAULTS, ...data });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;

    // ONLY SET WHAT IS CONFIGURED AND VALID. Writing an empty or malformed
    // value would REPLACE the stylesheet default with nothing, and every
    // `bg-[var(--kl-primary)]` would render transparent - a blank site caused
    // by a field an admin cleared.
    if (HEX.test(branding.primaryColour || "")) {
      root.style.setProperty("--kl-primary", branding.primaryColour);
    }
    if (HEX.test(branding.secondaryColour || "")) {
      root.style.setProperty("--kl-primary-dark", branding.secondaryColour);
    }

    if (branding.organisationName) document.title = branding.organisationName;
  }, [branding]);

  return <BrandingContext.Provider value={branding}>{children}</BrandingContext.Provider>;
}

/** Read the branding. Never throws and never returns undefined. */
export function useBranding() {
  return useContext(BrandingContext) || DEFAULTS;
}

export { DEFAULTS as BRANDING_DEFAULTS };

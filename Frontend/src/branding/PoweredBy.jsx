/**
 * =============================================================================
 * The attribution footer (SPEC-5 package 5.4, section 5.2)
 * =============================================================================
 * > Powered by KindLedger Donation System
 *
 * **NOT CONFIGURABLE.** There is no field for it in `branding_settings`, no
 * control on the admin page, and no prop on this component. Putting it in the
 * settings table would make removing it a SUPPORTED ACTION, which defeats the
 * purpose - and the purpose is that an NGO's donors can find the software.
 *
 * -----------------------------------------------------------------------------
 * APACHE-2.0 DOES NOT PROTECT THIS FOOTER (ADR-061)
 * -----------------------------------------------------------------------------
 * **A fork may remove it, lawfully.** Section 4(d) carries the NOTICE file into
 * derivative works; it says nothing about what the application renders at
 * runtime.
 *
 * This is stated here, next to the code, so that nobody later believes the
 * licence is doing work it is not. The honour system is a DELIBERATE CHOICE -
 * the alternative is a clause forbidding removal, which would make this project
 * not open source under the OSI definition. That trade was made knowingly.
 *
 * The absence of a config surface is therefore a statement of intent, not an
 * enforcement mechanism. Anyone editing this file can delete it in one line,
 * and that is understood.
 *
 * -----------------------------------------------------------------------------
 * IT IS NOT THE NGO'S FOOTER
 * -----------------------------------------------------------------------------
 * `branding_settings.footer_text` is the organisation's own line - their
 * registration number, their address, whatever they need. It renders
 * separately. SPEC-5 5.2 requires these to be two different things and they
 * must not be merged into one field: merged, removing the attribution becomes a
 * side effect of editing your own footer.
 * =============================================================================
 */

import React from "react";

const REPO = "https://github.com/Garyson26/kindledger-donation-system";

function PoweredBy() {
  return (
    <p className="text-sm text-gray-500 flex items-center justify-center gap-1.5">
      <span>Powered by</span>
      <a
        href={REPO}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 font-medium text-gray-600 hover:text-[var(--kl-primary)] transition-colors"
      >
        {/* The GitHub mark, inline rather than an asset request: it must render
            on a self-hosted install with no network access to a CDN. */}
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          width="14"
          height="14"
          fill="currentColor"
          className="shrink-0"
        >
          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
        </svg>
        KindLedger Donation System
      </a>
    </p>
  );
}

export default PoweredBy;

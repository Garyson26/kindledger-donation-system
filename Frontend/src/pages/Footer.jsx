import React from "react";
import { useBranding } from "../branding/BrandingProvider";
import PoweredBy from "../branding/PoweredBy";

function Footer() {
  const { organisationName, footerText } = useBranding();

  return (
    <footer className="bg-gray-900 border-t border-gray-800 mt-auto">
      <div className="max-w-7xl mx-auto py-3 px-4 sm:px-6 lg:px-8">
        <div className="text-center space-y-1">
          {/* ONE LINE (DQ1): the copyright, then the attribution. They wrap as
              two units on a narrow screen, so nothing overflows; the middot
              shows only from md up, where they share a line, so a wrapped
              footer never leaves a separator hanging at a line end. */}
          <p className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-sm">
            <span className="text-gray-400 max-w-full">
              © {new Date().getFullYear()} {organisationName}. All rights reserved.
            </span>
            <span aria-hidden="true" className="hidden md:inline text-gray-500">
              ·
            </span>
            {/* NOT configurable. See branding/PoweredBy.jsx - and note that
                Apache-2.0 does not protect it (ADR-061). */}
            <PoweredBy />
          </p>

          {/* The NGO's OWN line, configurable, and separate from the
              attribution above. SPEC-5 5.2: merged into one field, removing the
              attribution would become a side effect of editing your own footer. */}
          {footerText ? <p className="text-gray-500 text-xs">{footerText}</p> : null}
        </div>
      </div>
    </footer>
  );
}

export default Footer;

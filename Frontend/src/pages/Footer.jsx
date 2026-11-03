import React from "react";
import { useBranding } from "../branding/BrandingProvider";
import PoweredBy from "../branding/PoweredBy";

function Footer() {
  const { organisationName, footerText } = useBranding();

  return (
    <footer className="bg-gray-900 border-t border-gray-800 mt-auto">
      <div className="max-w-7xl mx-auto py-3 px-4 sm:px-6 lg:px-8">
        <div className="text-center space-y-1">
          <p className="text-gray-400 text-sm">
            © {new Date().getFullYear()} {organisationName}. All rights reserved.
          </p>

          {/* The NGO's OWN line, configurable, and separate from the
              attribution below. SPEC-5 5.2: merged into one field, removing the
              attribution would become a side effect of editing your own footer. */}
          {footerText ? <p className="text-gray-500 text-xs">{footerText}</p> : null}

          {/* NOT configurable. See branding/PoweredBy.jsx - and note that
              Apache-2.0 does not protect it (ADR-061). */}
          <div className="pt-1">
            <PoweredBy />
          </div>
        </div>
      </div>
    </footer>
  );
}

export default Footer;

/**
 * =============================================================================
 * Branding settings (SPEC-5 package 5.2, section 3.4)
 * =============================================================================
 * The admin form for `branding_settings` - the singleton that has existed since
 * Phase 1a with no interface at all (AS4).
 *
 * TWO THINGS THAT LOOK LIKE POLISH AND ARE NOT:
 *
 * 1. THE SAVE REPORTS WHAT CHANGED, using the `changed` array the API computes
 *    against the stored row. A form posts every field every time, so a message
 *    built from the form state would always say "everything". The server is the
 *    only party that knows what was actually different.
 *
 * 2. THE PREVIEW IS DRIVEN BY THE FORM STATE, not by a saved response, so an
 *    admin sees the colours before committing them. It is a swatch rather than
 *    a mock page: showing a fake donation page here would invite trusting it,
 *    and the real page is one click away.
 * =============================================================================
 */

import React, { useState, useEffect } from "react";
import { adminAPI } from "../utils/api";
import Toast from "../components/Toast";
import { useToast } from "../utils/useToast";

/** Every field the API accepts, so the form cannot drift from the contract. */
const EMPTY = {
  organisationName: "",
  primaryColour: "",
  secondaryColour: "",
  supportEmail: "",
  websiteUrl: "",
  footerText: "",
  defaultCurrency: "INR",
};

const HEX = /^#[0-9A-Fa-f]{6}$/;

function AdminBranding() {
  const { toasts, showToast, hideToast } = useToast();
  const [form, setForm] = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, ok, error } = await adminAPI.getBranding();
      if (cancelled) return;
      if (!ok) {
        showToast(error || "Failed to load branding settings", "error");
        setLoading(false);
        return;
      }
      setForm({
        organisationName: data.organisationName || "",
        primaryColour: data.primaryColour || "",
        secondaryColour: data.secondaryColour || "",
        supportEmail: data.supportEmail || "",
        websiteUrl: data.websiteUrl || "",
        footerText: data.footerText || "",
        defaultCurrency: data.defaultCurrency || "INR",
      });
      setUpdatedAt(data.updatedAt || null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);

    const { data, ok, error } = await adminAPI.updateBranding(form);
    setSaving(false);

    if (!ok) {
      // The API reports EVERY problem in one string, so this shows all of them
      // rather than the first. A settings form that reveals one bad field per
      // round trip is one people stop using.
      showToast(error || "Failed to save branding settings", "error");
      return;
    }

    // `data.changed` is computed by the server against the stored row.
    showToast(data.message || "Saved", "success");
    if (data.branding && data.branding.updatedAt) setUpdatedAt(data.branding.updatedAt);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 py-8">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
          <p className="text-gray-600">Loading branding settings…</p>
        </div>
      </div>
    );
  }

  const swatch = (value) => (HEX.test(value) ? value : "transparent");

  return (
    <div className="min-h-screen bg-gray-50 py-8">
      {toasts.map((toast) => (
        <Toast key={toast.id} message={toast.message} type={toast.type} onClose={() => hideToast(toast.id)} />
      ))}

      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900">Branding</h1>
          <p className="mt-2 text-gray-600">
            How this installation presents itself to donors.
            {updatedAt ? ` Last changed ${new Date(updatedAt).toLocaleString()}.` : ""}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="bg-white rounded-lg shadow p-6 space-y-6">
          <div>
            <label htmlFor="organisationName" className="block text-sm font-medium text-gray-700">
              Organisation name
            </label>
            <input
              id="organisationName"
              type="text"
              maxLength={160}
              required
              value={form.organisationName}
              onChange={set("organisationName")}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2"
            />
            <p className="mt-1 text-sm text-gray-500">
              Replaces the organisation name everywhere donors see it, including the receipt.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {[
              ["primaryColour", "Primary colour"],
              ["secondaryColour", "Secondary colour"],
            ].map(([field, label]) => (
              <div key={field}>
                <label htmlFor={field} className="block text-sm font-medium text-gray-700">
                  {label}
                </label>
                <div className="mt-1 flex items-center gap-3">
                  <input
                    id={field}
                    type="text"
                    placeholder="#1A2B3C"
                    value={form[field]}
                    onChange={set(field)}
                    className="block w-full rounded-md border border-gray-300 px-3 py-2 font-mono"
                  />
                  {/* THE LIVE PREVIEW. A bordered swatch rather than a filled
                      box, so an empty or invalid value is visibly nothing
                      instead of looking like white. */}
                  <span
                    aria-label={`${label} preview`}
                    className="inline-block h-9 w-9 rounded border border-gray-300 shrink-0"
                    style={{ backgroundColor: swatch(form[field]) }}
                  />
                </div>
                {form[field] && !HEX.test(form[field]) ? (
                  <p className="mt-1 text-sm text-amber-700">
                    Not a hex colour yet — six digits, like #1A2B3C.
                  </p>
                ) : null}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="supportEmail" className="block text-sm font-medium text-gray-700">
                Support email
              </label>
              <input
                id="supportEmail"
                type="email"
                maxLength={255}
                value={form.supportEmail}
                onChange={set("supportEmail")}
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2"
              />
            </div>
            <div>
              <label htmlFor="websiteUrl" className="block text-sm font-medium text-gray-700">
                Website
              </label>
              <input
                id="websiteUrl"
                type="url"
                maxLength={512}
                placeholder="https://example.org"
                value={form.websiteUrl}
                onChange={set("websiteUrl")}
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2"
              />
              <p className="mt-1 text-sm text-gray-500">Must be http or https.</p>
            </div>
          </div>

          <div>
            <label htmlFor="footerText" className="block text-sm font-medium text-gray-700">
              Footer text
            </label>
            <textarea
              id="footerText"
              rows={2}
              maxLength={500}
              value={form.footerText}
              onChange={set("footerText")}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2"
            />
            {/* SPEC-5 5.2: these are two different things and must not be
                merged into one field. The attribution line is not configurable
                and has no control here - deliberately. */}
            <p className="mt-1 text-sm text-gray-500">
              Your own footer line. Separate from the “Powered by KindLedger” attribution, which is
              not configurable.
            </p>
          </div>

          <div className="sm:w-40">
            <label htmlFor="defaultCurrency" className="block text-sm font-medium text-gray-700">
              Currency
            </label>
            <input
              id="defaultCurrency"
              type="text"
              maxLength={3}
              value={form.defaultCurrency}
              onChange={(e) => setForm((f) => ({ ...f, defaultCurrency: e.target.value.toUpperCase() }))}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 font-mono uppercase"
            />
          </div>

          <div className="flex items-center gap-3 pt-2">
            <button
              type="submit"
              disabled={saving}
              className="inline-flex justify-center rounded-md bg-blue-600 px-4 py-2 text-white font-medium hover:bg-blue-700 disabled:opacity-60"
            >
              {saving ? "Saving…" : "Save changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default AdminBranding;

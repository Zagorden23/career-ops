/**
 * @typedef {object} ApplyField
 * @property {string} id our stable handle, also set as data-co-field on the live element
 * @property {"text" | "email" | "tel" | "url" | "number" | "date" | "textarea" | "select" | "checkbox" | "radio" | "file"} type
 * @property {string} label
 * @property {boolean} required
 * @property {string[]} [options]
 * @property {number} [maxLength]
 * @property {string} [value]
 * @property {boolean} [combobox] react-select-style widget → fill via click+type+Enter, not selectOption
 * @property {string} [nativeId] the live element's id/name — used to match ATS API schemas (Greenhouse)
 * @property {string} [nativeName]
 */

// Extract the application form's STRUCTURE (not pixels) and TAG each control with
// a stable `data-co-field` id on the LIVE page (which the session keeps open), so
// the later fill phase can locate each field deterministically. Generic DOM/a11y
// introspection — clean ATS (Ashby/Lever/Greenhouse) work well; Workday best-effort.
export async function extractForm(ctx) {
  const data = await ctx.evaluate(() => {
    const clean = (s) => (s || "").replace(/\s+/g, " ").trim().slice(0, 160);
    const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.trim());
    // generic placeholders that masquerade as labels (Ashby/react-select)
    const isGenericPh = (s) => /^(start typing|select\b|choose|search\b|type\b|--|please select|e\.?g\.?)/i.test(s.trim());
    // a usable label: not empty, not a UUID, not a generic placeholder
    const ok = (s) => {
      const t = (s || "").trim();
      return t && !isUuid(t) && !isGenericPh(t) ? t : "";
    };
    // Pure label text: a wrapping <label>Gender<select>…</select></label> would
    // otherwise swallow all option text (Lever). Strip controls/options first.
    const pure = (node) => {
      if (!node) return "";
      const c = node.cloneNode(true);
      c.querySelectorAll?.("input, select, textarea, option, button, [role=option], [class*='menu' i]").forEach((n) => n.remove());
      return clean(c.textContent);
    };

    // The field WRAPPER (Ashby `ashby-application-form-field-entry`, Greenhouse
    // `select__container`/`field`, generic `form-group`/`fieldset`) — deliberately
    // NOT a bare `div` (that matches the immediate parent and misses the real label
    // which lives one wrapper up).
    function fieldGroup(el) {
      return el.closest(
        '[class*="field-entry" i], [class*="fieldEntry" i], [class*="form-group" i], [class*="question" i], [class*="field__" i], [class*="__field" i], fieldset, [class*="field" i]',
      );
    }

    function labelFor(el) {
      const aria = el.getAttribute("aria-label");
      if (ok(aria)) return aria;
      const labelledby = el.getAttribute("aria-labelledby");
      if (labelledby) {
        const t = labelledby.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ");
        if (ok(t)) return t;
      }
      const id = el.id;
      if (id) {
        const l = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (l && ok(pure(l))) return pure(l);
      }
      const parentLabel = el.closest("label");
      if (parentLabel && ok(pure(parentLabel))) return pure(parentLabel);
      // the question title inside the field wrapper (handles Ashby's
      // `ashby-application-form-question-title`, Greenhouse `select__label`, etc.)
      const grp = fieldGroup(el);
      if (grp) {
        const lab = grp.querySelector(
          'label, legend, [class*="question-title" i], [class*="heading" i], [class*="label" i], [class*="title" i]',
        );
        if (lab && ok(pure(lab))) return pure(lab);
      }
      // walk up a few ancestors for a nearby label/heading
      let c = el.parentElement;
      for (let i = 0; i < 4 && c; i++, c = c.parentElement) {
        const lab = c.querySelector('label, legend, [class*="label" i], [class*="title" i], h3, h4, h5');
        if (lab && ok(pure(lab))) return pure(lab);
      }
      const ph = el.placeholder;
      if (ok(ph)) return ph;
      const name = el.name;
      return ok(name); // never a UUID/placeholder; "" → caller shows "Untitled"
    }

    // The QUESTION of a radio group — NOT the first option's label. Look for a
    // radiogroup/fieldset aria-label/legend, else the first label/heading in the
    // group's container that isn't one of the options.
    function groupLabel(firstRadio, options) {
      const rg = firstRadio.closest("[role=radiogroup], fieldset");
      if (rg) {
        const al = rg.getAttribute("aria-label");
        if (al) return al;
        const lb = rg.getAttribute("aria-labelledby");
        if (lb) {
          const t = lb.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ");
          if (t.trim()) return t;
        }
        const legend = rg.querySelector("legend");
        if (legend?.textContent?.trim()) return legend.textContent;
      }
      const optSet = new Set(options.map((o) => o.toLowerCase()));
      const container = fieldGroup(firstRadio) || firstRadio.parentElement?.parentElement || firstRadio.parentElement;
      if (container) {
        const cands = container.querySelectorAll(
          'label, legend, h1, h2, h3, h4, h5, h6, [class*="question-title" i], [class*="heading" i], [class*="label" i], [class*="title" i], [class*="question" i]',
        );
        for (const c of Array.from(cands)) {
          const t = pure(c);
          if (t && t.length > 2 && t.length < 160 && !optSet.has(t.toLowerCase()) && !isUuid(t) && !isGenericPh(t)) return t;
        }
      }
      return "";
    }

    const fields = [];
    const seenRadio = new Set();
    const els = Array.from(document.querySelectorAll("input, textarea, select"));
    let n = 0;

    for (const el of els) {
      const tag = el.tagName.toLowerCase();
      const itype = (el.type || "").toLowerCase();
      if (tag === "input" && ["hidden", "submit", "button", "image", "reset"].includes(itype)) continue;
      if (el.offsetParent === null && itype !== "radio" && itype !== "checkbox") continue;
      // skip ATS "autofill from resume / parse my CV" helper widgets (Ashby) — these
      // are convenience uploaders, not real application fields.
      if (el.closest('[class*="autofill" i]')) continue;

      // react-select widgets render an extra internal/autosize <input> next to the
      // real role=combobox input. Keep ONLY the combobox; drop the dummy (it's the
      // "Untitled field" noise). The combobox carries the question's aria label.
      const inReactSelect = el.closest('[class*="select__"], .select-shell');
      const isCombobox = el.getAttribute("role") === "combobox";
      if (inReactSelect && tag === "input" && !isCombobox) continue;

      const required = el.required || el.getAttribute("aria-required") === "true";
      const nativeId = el.id || undefined;
      const nativeName = el.name || undefined;
      const fid = `co${n++}`;

      if (isCombobox) {
        el.setAttribute("data-co-field", fid);
        fields.push({ id: fid, type: "select", combobox: true, label: clean(labelFor(el)), required, options: [], nativeId, nativeName });
        continue;
      }

      if (itype === "radio") {
        const name = el.name;
        if (name && seenRadio.has(name)) {
          n--;
          continue;
        }
        if (name) seenRadio.add(name);
        const group = Array.from(document.querySelectorAll(`input[type=radio][name="${CSS.escape(name)}"]`));
        const options = group.map((r) => clean(labelFor(r) || r.value)).filter(Boolean);
        group.forEach((r, i) => {
          r.setAttribute("data-co-field", fid);
          r.setAttribute("data-co-option", options[i] ?? String(i));
        });
        fields.push({ id: fid, type: "radio", label: clean(groupLabel(el, options)) || name, required, options });
        continue;
      }

      el.setAttribute("data-co-field", fid);

      if (tag === "select") {
        const options = Array.from(el.options).map((o) => clean(o.textContent)).filter((o) => o && !/^(select|choose|--)/i.test(o));
        fields.push({ id: fid, type: "select", label: clean(labelFor(el)), required, options, nativeId, nativeName });
        continue;
      }
      const type = tag === "textarea" ? "textarea" : ["email", "tel", "url", "number", "date", "checkbox", "file"].includes(itype) ? itype : "text";
      const ml = el.maxLength;
      fields.push({
        id: fid,
        type,
        label: clean(labelFor(el)),
        required,
        maxLength: ml && ml > 0 ? ml : undefined,
        value: el.value || undefined,
        nativeId,
        nativeName,
      });
    }
    return { title: document.title, fields };
  });

  return { title: data.title, url: ctx.url(), fields: data.fields };
}

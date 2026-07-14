// Light validation for Properties-panel attribute edits. Pure + vscode-free. The DITA grammar is
// permissive about most metadata attributes (audience/platform/product/props/otherprops/rev are
// free CDATA token lists), so the only hard syntactic constraint worth enforcing in the editor is
// that @id is a valid XML name (NCName) — an invalid id breaks xref/conref resolution. Everything
// else passes; a future enum layer (e.g. constrained @status) can extend this.

/** XML NCName: a letter/underscore start, then letters/digits/-/_/. (no colon). */
const NCNAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** CALS presentation attributes with a closed value set (F1/F3/F4/F5 editors).
 *  Values are the DITA/CALS enumerations; anything else would not round-trip
 *  through DITA-OT cleanly, so the editor refuses it before any bytes change. */
const ENUM_ATTRS: Record<string, readonly string[]> = {
  frame: ['top', 'bottom', 'topbot', 'all', 'sides', 'none'],
  colsep: ['0', '1'],
  rowsep: ['0', '1'],
  align: ['left', 'right', 'center', 'justify', 'char'],
  valign: ['top', 'middle', 'bottom'],
};

/** Returns an error reason if `value` is invalid for attribute `name`, else null (valid). An empty
 *  value is always allowed here (the host treats it as "remove the attribute"). */
export function attrValueError(name: string, value: string): string | null {
  if (value === '') return null;
  if (name === 'id') {
    if (!NCNAME.test(value)) {
      return 'An id must be an XML name: start with a letter or underscore, then letters, digits, “-”, “_”, or “.” (no spaces).';
    }
  }
  const allowed = ENUM_ATTRS[name];
  if (allowed && !allowed.includes(value)) {
    return `${name} must be one of: ${allowed.join(', ')}.`;
  }
  return null;
}

const DITA_IMAGE_DIMENSION = /^(?:\d+(?:\.\d+)?|\.\d+)(?:cm|em|in|mm|pc|pt|px)?$/;

/** DITA image @width/@height: a positive decimal length with an optional supported unit. */
export function imageDimensionError(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (!DITA_IMAGE_DIMENSION.test(trimmed) || Number.parseFloat(trimmed) <= 0) {
    return 'Image width must be a positive number, optionally followed by cm, em, in, mm, pc, pt, or px.';
  }
  return null;
}

import type { ReviewRevertPlan } from '../compare/revert-change';

export interface ReviewRevertAuthorization extends ReviewRevertPlan {
  token: string;
  uri: string;
  generation: number;
  documentVersion: number;
  source: string;
}

export interface CurrentReviewDocument {
  uri: string;
  generation: number;
  documentVersion: number;
  source: string;
}

export type ReviewRevertValidation =
  | { ok: true; plan: ReviewRevertPlan }
  | { ok: false; reason: string };

/** Validate every host-owned assumption immediately before a WorkspaceEdit. */
export function validateReviewRevert(
  authorization: ReviewRevertAuthorization,
  current: CurrentReviewDocument,
): ReviewRevertValidation {
  if (authorization.uri !== current.uri) {
    return { ok: false, reason: 'The Review action belongs to a different document.' };
  }
  if (authorization.generation !== current.generation) {
    return { ok: false, reason: 'The Review action is stale because the comparison changed.' };
  }
  if (authorization.documentVersion !== current.documentVersion) {
    return { ok: false, reason: 'The document changed after this Review action was created.' };
  }
  if (authorization.source !== current.source) {
    return { ok: false, reason: 'The document no longer matches the reviewed Newer version.' };
  }
  if (
    authorization.start < 0
    || authorization.end < authorization.start
    || authorization.end > current.source.length
  ) {
    return { ok: false, reason: 'The Review action contains an invalid document range.' };
  }
  if (current.source.slice(authorization.start, authorization.end) !== authorization.expected) {
    return { ok: false, reason: 'The selected change no longer matches the reviewed bytes.' };
  }
  return {
    ok: true,
    plan: {
      key: authorization.key,
      label: authorization.label,
      start: authorization.start,
      end: authorization.end,
      expected: authorization.expected,
      replacement: authorization.replacement,
    },
  };
}

/**
 * Artist attribution rules confirmed by the sponsor (Brad):
 * - Orchard `TRACK ARTIST` is the track performer.
 * - Orchard `PRODUCT ARTIST` is the main release entity.
 * - Brad determines primary, secondary, and tertiary attribution.
 * - Featured-artist designations are managed through Vydia, never derived here.
 */

export type ArtistAttributionStatus =
  | "AGREES"
  | "TRACK_ARTIST_ONLY"
  | "PRODUCT_ARTIST_ONLY"
  | "CONFLICT"
  | "MISSING";

export type ArtistAttributionDecision = {
  /** Orchard TRACK ARTIST: the track performer. */
  trackArtist: string | null;
  /** Orchard PRODUCT ARTIST: the main release entity. */
  productArtist: string | null;
  status: ArtistAttributionStatus;
  /**
   * Distinct Orchard source values offered to the reviewer. These are
   * suggestions only; none is ever promoted to the Exact Artist automatically.
   */
  candidateExactArtists: string[];
  /** Always true: the Mediabase Exact Artist is a human decision. */
  requiresConfirmation: true;
  confirmed: boolean;
  /** Mediabase Exact Artist selected by a human reviewer. */
  confirmedExactArtist: string | null;
  primaryArtist: string | null;
  secondaryArtist: string | null;
  tertiaryArtist: string | null;
  featuredArtistSource: "VYDIA";
  /**
   * Orchard artist values the reviewer saw when confirming. A confirmation is
   * stale once either source value changes.
   */
  confirmedSource: { trackArtist: string | null; productArtist: string | null } | null;
};

export type ArtistAttributionProblemCode =
  | "attribution-missing"
  | "attribution-inconsistent"
  | "confirmation-stale"
  | "conflict-unconfirmed"
  | "unconfirmed"
  | "artist-mismatch";

export type ArtistAttributionProblem = { code: ArtistAttributionProblemCode; message: string };

export type ArtistAttributionSelection = {
  exactArtist: string;
  primaryArtist?: string | null;
  secondaryArtist?: string | null;
  tertiaryArtist?: string | null;
};

function sameArtist(left: string, right: string): boolean {
  const normalize = (value: string) => value.trim().replace(/\s+/g, " ").toUpperCase();
  return normalize(left) === normalize(right);
}

export function createArtistAttributionDecision(
  trackArtist: string | null,
  productArtist: string | null
): ArtistAttributionDecision {
  let status: ArtistAttributionStatus;
  if (trackArtist !== null && productArtist !== null) {
    status = sameArtist(trackArtist, productArtist) ? "AGREES" : "CONFLICT";
  } else if (trackArtist !== null) {
    status = "TRACK_ARTIST_ONLY";
  } else if (productArtist !== null) {
    status = "PRODUCT_ARTIST_ONLY";
  } else {
    status = "MISSING";
  }

  const candidateExactArtists: string[] = [];
  for (const name of [trackArtist, productArtist]) {
    if (name !== null && !candidateExactArtists.some((candidate) => sameArtist(candidate, name))) {
      candidateExactArtists.push(name);
    }
  }

  return {
    trackArtist,
    productArtist,
    status,
    candidateExactArtists,
    requiresConfirmation: true,
    confirmed: false,
    confirmedExactArtist: null,
    primaryArtist: null,
    secondaryArtist: null,
    tertiaryArtist: null,
    featuredArtistSource: "VYDIA",
    confirmedSource: null
  };
}

function optionalName(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : null;
}

export function confirmArtistAttribution(
  decision: ArtistAttributionDecision,
  selection: ArtistAttributionSelection
): ArtistAttributionDecision {
  const exactArtist = selection.exactArtist.trim();
  if (!exactArtist) {
    throw new Error("Confirmed Mediabase Exact Artist must not be empty.");
  }
  // Rebuild from the source values so an edited status or candidate list is not carried forward.
  return {
    ...createArtistAttributionDecision(decision.trackArtist, decision.productArtist),
    confirmed: true,
    confirmedExactArtist: exactArtist,
    primaryArtist: optionalName(selection.primaryArtist),
    secondaryArtist: optionalName(selection.secondaryArtist),
    tertiaryArtist: optionalName(selection.tertiaryArtist),
    confirmedSource: { trackArtist: decision.trackArtist, productArtist: decision.productArtist }
  };
}

/**
 * Returns the first reason the record's artist attribution blocks approval, or
 * null. `requiresDecision` is true for Orchard-imported recordings, so omitting
 * the decision object cannot bypass confirmation.
 */
export function findArtistAttributionProblem(
  artist: string,
  attribution: ArtistAttributionDecision | undefined,
  requiresDecision: boolean
): ArtistAttributionProblem | null {
  if (!attribution) {
    return requiresDecision
      ? {
          code: "attribution-missing",
          message:
            "Recording has no artist attribution decision and is not marked as a legacy manual record; the Mediabase Exact Artist must be explicitly confirmed before approval."
        }
      : null;
  }
  // Gate on `confirmed`, not the stored `requiresConfirmation` flag, so an
  // edited decision object cannot bypass the human selection.
  if (!attribution.confirmed) {
    return attribution.status === "CONFLICT"
      ? {
          code: "conflict-unconfirmed",
          message: "Conflicting Orchard artist attribution must be explicitly confirmed before approval."
        }
      : {
          code: "unconfirmed",
          message:
            "Mediabase Exact Artist must be explicitly confirmed from the Orchard artist attribution before approval."
        };
  }
  if (!attribution.confirmedExactArtist?.trim() || !attribution.confirmedSource) {
    return {
      code: "attribution-inconsistent",
      message: "Artist attribution data is inconsistent with the Orchard artist values; the Exact Artist must be confirmed again."
    };
  }
  if (
    attribution.confirmedSource.trackArtist !== attribution.trackArtist ||
    attribution.confirmedSource.productArtist !== attribution.productArtist
  ) {
    return {
      code: "confirmation-stale",
      message: "Orchard artist values changed after the Exact Artist was confirmed; a new explicit confirmation is required."
    };
  }
  if (attribution.status !== createArtistAttributionDecision(attribution.trackArtist, attribution.productArtist).status) {
    return {
      code: "attribution-inconsistent",
      message: "Artist attribution data is inconsistent with the Orchard artist values; the Exact Artist must be confirmed again."
    };
  }
  if (artist !== attribution.confirmedExactArtist) {
    return { code: "artist-mismatch", message: "Exact Artist differs from the confirmed artist attribution." };
  }
  return null;
}

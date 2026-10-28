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
};

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
    featuredArtistSource: "VYDIA"
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
  return {
    ...decision,
    confirmed: true,
    confirmedExactArtist: exactArtist,
    primaryArtist: optionalName(selection.primaryArtist),
    secondaryArtist: optionalName(selection.secondaryArtist),
    tertiaryArtist: optionalName(selection.tertiaryArtist)
  };
}

import { describe, expect, it } from "vitest";

import { displayNameOf } from "./personName";

describe("displayNameOf", () => {
  it("prefers display name, then full name, then email", () => {
    expect(displayNameOf({ displayName: "Pres", firstName: "Preston", email: "p@x" })).toBe("Pres");
    expect(displayNameOf({ firstName: "Preston", lastName: "M", email: "p@x" })).toBe("Preston M");
    expect(displayNameOf({ email: "p@x" })).toBe("p@x");
  });

  it("handles a half-onboarded user with only one name (D-28)", () => {
    expect(displayNameOf({ firstName: "Preston", email: "p@x" })).toBe("Preston");
    expect(displayNameOf({ lastName: "M", email: "p@x" })).toBe("M");
  });

  it("treats whitespace-only values as absent", () => {
    expect(displayNameOf({ displayName: "   ", firstName: "Preston" })).toBe("Preston");
    expect(displayNameOf({ firstName: " ", lastName: " ", email: "p@x" })).toBe("p@x");
  });

  /** receipts.uploaded_by is ON DELETE SET NULL, so this is reachable. */
  it("names an absent uploader rather than rendering blank", () => {
    expect(displayNameOf(null)).toBe("Unknown user");
    expect(displayNameOf({})).toBe("Unknown user");
  });
});

// Only the application's two base64-decoded 32-byte keys may differ in trailing
// padding. Never normalize other secrets, configuration or key material.
export function compareRuntimeSettings(configured, effective) {
  const differingKeys = Object.keys(configured).filter(
    (key) => configured[key] !== effective[key],
  );
  const keyNames = new Set([
    "PARTNER_PROOF_SHARE_TOKEN_KEY_BASE64",
    "PARTNER_LOCATION_SECRET_KEY_BASE64",
  ]);
  const paddingEquivalentKeys = differingKeys.filter((key) => {
    const a = configured[key],
      b = effective[key];
    if (
      !keyNames.has(key) ||
      !/^[A-Za-z0-9+/]{43}=?$/.test(a) ||
      !/^[A-Za-z0-9+/]{43}=?$/.test(b)
    )
      return false;
    const first = Buffer.from(a, "base64"),
      second = Buffer.from(b, "base64");
    return (
      first.length === 32 &&
      second.length === 32 &&
      first.equals(second) &&
      first.toString("base64").replace(/=+$/, "") === a.replace(/=+$/, "") &&
      a.replace(/=+$/, "") === b.replace(/=+$/, "")
    );
  });
  return {
    differingKeys,
    paddingEquivalentKeys,
    unexplainedDifferences: differingKeys.filter(
      (key) => !paddingEquivalentKeys.includes(key),
    ),
  };
}

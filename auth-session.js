/** Compare a JWT's session version with the user's current database version.
 * Older tokens without `sv` are treated as version 0 for backwards compatibility.
 */
export function isSessionVersionCurrent(tokenVersion, currentVersion) {
  if (!Number.isInteger(Number(currentVersion)) || Number(currentVersion) < 0) return false;
  const issuedVersion = tokenVersion === undefined || tokenVersion === null ? 0 : Number(tokenVersion);
  return Number.isInteger(issuedVersion) && issuedVersion >= 0 && issuedVersion === Number(currentVersion);
}

export function parsePreviewAddress(input: string): string {
  const address = input.trim();
  const url = new URL(address.includes("://") ? address : `http://${address}`);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error(
      "Enter an http:// or https:// address without credentials.",
    );
  }
  return url.href;
}

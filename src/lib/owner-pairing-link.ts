export function ownerPairingTicketFromLocation(hash: string, search: string): string {
  const fragmentTicket = hash.startsWith("#") ? hash.slice(1) : hash;
  return fragmentTicket || new URLSearchParams(search).get("ticket") || "";
}

export function ownerPairingUrl(publicUrl: string, ticket: string): string {
  const url = new URL("/pair", publicUrl.endsWith("/") ? publicUrl : `${publicUrl}/`);
  url.searchParams.set("ticket", ticket);
  return url.toString();
}

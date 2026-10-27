import { BitbucketRepository } from "./types";

const BITBUCKET_HOST = "bitbucket.org";

export function parseBitbucketRemoteUrl(remoteUrl: string): BitbucketRepository | undefined {
  const trimmed = remoteUrl.trim();
  const scpMatch = trimmed.includes("://")
    ? undefined
    : trimmed.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
  let hostname: string;
  let pathname: string;

  if (scpMatch) {
    hostname = scpMatch[1];
    pathname = scpMatch[2];
  } else {
    try {
      const url = new URL(trimmed);
      hostname = url.hostname;
      pathname = url.pathname;
    } catch {
      return undefined;
    }
  }

  if (hostname.toLowerCase() !== BITBUCKET_HOST) {
    return undefined;
  }

  const segments = pathname
    .replace(/^\/+/, "")
    .replace(/\.git$/i, "")
    .split("/")
    .filter(Boolean);

  if (segments.length !== 2) {
    return undefined;
  }

  const [workspace, slug] = segments;
  return {
    workspace,
    slug,
    fullName: `${workspace}/${slug}`,
  };
}

'use strict';

/**
 * Règles pures des canaux de mise à jour.
 *
 * Ce module ne dépend ni d'Electron ni du réseau : il est testable avec Node.
 * Le canal stable ne doit jamais accepter une version pré-release. Le canal
 * bêta accepte les versions stables et les versions `-beta.N`, mais pas les
 * canaux alpha/rc non pris en charge par FreeRAM.
 */

const CHANNELS = Object.freeze(['stable', 'beta']);
const BETA_PATTERN = /-beta\.\d+(?:\.\d+)?$/i;
const PRERELEASE_PATTERN = /-/;

function normalizeChannel(value) {
  return value === 'beta' ? 'beta' : 'stable';
}

function isPrerelease(version) {
  return PRERELEASE_PATTERN.test(String(version || ''));
}

function isBetaVersion(version) {
  return BETA_PATTERN.test(String(version || ''));
}

function channelForVersion(version) {
  return isBetaVersion(version) ? 'beta' : 'stable';
}

function isAllowedVersion(version, channel) {
  if (!version) return false;
  const normalized = normalizeChannel(channel);
  if (normalized === 'stable') return !isPrerelease(version);
  return !isPrerelease(version) || isBetaVersion(version);
}

function updateChannelName(channel) {
  return normalizeChannel(channel) === 'beta' ? 'beta' : 'latest';
}

function updateFileName(channel) {
  return `${updateChannelName(channel)}.yml`;
}

function releasesUrl(owner, repo) {
  if (!owner || !repo) return 'https://github.com';
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases`;
}

module.exports = {
  CHANNELS,
  normalizeChannel,
  isPrerelease,
  isBetaVersion,
  channelForVersion,
  isAllowedVersion,
  updateChannelName,
  updateFileName,
  releasesUrl
};

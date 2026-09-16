export {
  detectHostEnvironment,
  isInHost,
  isTruApiRuntime,
  isProductWebSocketBlocked,
  type HostEnvironment,
} from "./detect"
export {
  describeHostConnectionFailure,
  type HostConnectionFailure,
  type HostConnectionState,
} from "./connection-status"
export { connectToHost, isHostConnected } from "./connection"
export {
  getPaseoIndividualityClient,
  getPaseoIndividualityClientAsync,
  getPaseoAssetHubClient,
  resetClients,
  PASEO_INDIVIDUALITY_GENESIS,
  PASEO_ASSET_HUB_GENESIS,
} from "./provider"
export { getHostAccounts, subscribeHostAccounts, type HostAccount } from "./accounts"
export { subscribeHostTheme, hostThemeToChoice, type HostTheme } from "./theme"

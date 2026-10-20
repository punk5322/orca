/** @type {import('@bacons/apple-targets').Config} */
module.exports = {
  type: 'watch',
  name: 'OrcaWatch',
  displayName: 'Orca',
  // Leading dot appends to the phone's bundle id, which watchOS requires of a companion app.
  bundleIdentifier: '.watchkitapp',
  deploymentTarget: '10.0',
  icon: '../../assets/icon.png'
}

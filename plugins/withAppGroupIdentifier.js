const { withXcodeProject } = require('@expo/config-plugins')

/**
 * Injects APP_GROUP_IDENTIFIER into all iOS build configurations.
 * This sets the value at the project level so targets inherit it.
 */
module.exports = function withAppGroupIdentifier(config, { appGroup }) {
  let setIdentifier = false
  return withXcodeProject(config, (config) => {
    const project = config.modResults
    const configs = project.pbxXCBuildConfigurationSection()

    Object.keys(configs).forEach((key) => {
      if (key.endsWith('_comment')) return
      const buildConfig = configs[key]
      if (!buildConfig.buildSettings) return
      buildConfig.buildSettings.APP_GROUP_IDENTIFIER = `"${appGroup}"`
      setIdentifier = true
    })

    if (setIdentifier)
      console.log(
        `Updated APP_GROUP_IDENTIFIER to ${appGroup} for all build configurations`
      )
    else
      console.warn(
        'Could not find any build configurations to set APP_GROUP_IDENTIFIER'
      )

    return config
  })
}

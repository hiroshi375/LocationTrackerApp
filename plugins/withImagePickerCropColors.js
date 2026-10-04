const {
    withAndroidColors,
    withAndroidColorsNight,
} = require("expo/config-plugins");

function setColors(config, colors) {
    const items = [
        ["expoCropToolbarColor", "#FFFFFF"],
        ["expoCropToolbarIconColor", "#111111"],
        ["expoCropToolbarActionTextColor", "#111111"],
        ["expoCropBackButtonIconColor", "#111111"],
        ["expoCropBackgroundColor", "#000000"],
    ];

    for (const [name, value] of items) {
        const existingIndex = colors.resources.color?.findIndex(
            (item) => item.$?.name === name,
        );

        const newItem = {
            $: { name },
            _: value,
        };

        if (existingIndex >= 0) {
            colors.resources.color[existingIndex] = newItem;
        } else {
            colors.resources.color = colors.resources.color || [];
            colors.resources.color.push(newItem);
        }
    }

    return colors;
}

module.exports = function withImagePickerCropColors(config) {
    config = withAndroidColors(config, (config) => {
        config.modResults = setColors(config, config.modResults);
        return config;
    });

    config = withAndroidColorsNight(config, (config) => {
        config.modResults = setColors(config, config.modResults);
        return config;
    });

    return config;
};

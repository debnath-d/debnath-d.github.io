module.exports = {
    lang: 'en-US',
    title: "keyb0ardninja's blog",
    description: 'the pursuit of truth',

    themeConfig: {
        // logo: 'https://vuejs.org/images/logo.png',
        contributorsText: 'Author',
        editLink: false,
    },
    markdown: {
        extractHeaders: {
            level: [2, 3, 4],
        },
        code: {
            lineNumbers: false,
        },
    },
};

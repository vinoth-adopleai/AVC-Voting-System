export default {
  extends: ['stylelint-config-standard'],
  rules: {
    'at-rule-no-unknown': [
      true,
      {
        ignoreAtRules: [
          'apply',
          'custom-variant',
          'reference',
          'screen',
          'theme',
          'utility',
          'variant',
        ],
      },
    ],
  },
}

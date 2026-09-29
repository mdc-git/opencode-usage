import eslintConfigXo from 'eslint-config-xo'

const config = [
  ...eslintConfigXo({
    prettier: 'compat',
    space: true,
    semicolon: false,
    gitignore: new URL('../.gitignore', import.meta.url).href
  }),
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        project: './tooling/tsconfig.json',
        projectService: false
      }
    }
  }
]

export default config

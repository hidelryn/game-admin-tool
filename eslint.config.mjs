// ESLint flat config (모노레포 공용)
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import importX from 'eslint-plugin-import-x';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', 'apps/api/drizzle/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    // npm workspaces 는 의존성을 루트로 끌어올려 선언 안 한 패키지도 import 된다 → 각 워크스페이스 package.json 기준으로 검사
    // 실행 코드(src)는 devDependencies 를 쓰면 안 된다 (운영 이미지에 없음)
    files: ['apps/*/src/**/*.{ts,tsx}', 'packages/*/src/**/*.ts'],
    plugins: { 'import-x': importX },
    rules: {
      'import-x/no-extraneous-dependencies': [
        'error',
        { devDependencies: false, optionalDependencies: false },
      ],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      // XSS 방지: 원시 HTML 삽입 금지 (architecture.md 5장)
      'no-restricted-properties': 'off',
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'dangerouslySetInnerHTML 사용 금지',
        },
      ],
    },
  },
);

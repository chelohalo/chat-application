const tsJestTransform = {
  '^.+\\.(t|j)sx?$': [
    'ts-jest',
    {
      tsconfig: {
        jsx: 'react-jsx',
        esModuleInterop: true,
        module: 'commonjs',
        target: 'ES2022',
        moduleResolution: 'node',
        strict: true,
        skipLibCheck: true,
      },
    },
  ],
};

const moduleNameMapper = { '^@/(.*)$': '<rootDir>/$1' };

/** @type {import('jest').Config} */
module.exports = {
  projects: [
    {
      displayName: 'components',
      testEnvironment: 'jsdom',
      testMatch: ['<rootDir>/__tests__/components/**/*.test.ts?(x)'],
      transform: tsJestTransform,
      moduleNameMapper,
      setupFiles: ['<rootDir>/jest.setup.js'],
    },
    {
      displayName: 'route',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/__tests__/route/**/*.test.ts'],
      transform: tsJestTransform,
      moduleNameMapper,
    },
  ],
};

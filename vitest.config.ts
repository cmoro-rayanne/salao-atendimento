import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Os testes de integração compartilham o mesmo Postgres/Redis e limpam tabelas:
    // rodar arquivos em sequência evita interferência entre eles.
    fileParallelism: false,
  },
});

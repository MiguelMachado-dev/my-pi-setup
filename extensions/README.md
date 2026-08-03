# qwen-usage — extensão do pi

Exibe o consumo do **Qwen Token Plan Individual** no pi: janela de 5 horas,
janela semanal (7 dias) e credit packs, com cores no footer e relatório
detalhado.

Fonte: APIs internas do console QwenCloud (as mesmas que a página
"Token Plan Individual" usa). Autenticação: sessão do browser (cookie +
sec_token).

## Instalação

Copie `qwen-usage.ts` para:

```
~/.pi/agent/extensions/qwen-usage.ts
```

No pi, rode `/reload` (ou reinicie).

## Configuração da sessão (uma vez por máquina / quando expirar)

1. Abra https://home.qwencloud.com/billing/subscription/token-plan-individual
   (logado na conta com a assinatura)
2. **F12** → aba **Network** → filtre por `custom.json` → **F5**
3. Botão direito em qualquer request `custom.json` → **Copy** → **Copy as cURL (bash)**
4. No pi: **`/qwen-usage-setup`** → cole o cURL no editor → confirme

A sessão fica salva em `~/.pi/agent/qwencloud-session.json` (contém seu
cookie de sessão do console — não compartilhe).

Quando o cookie expirar (dias/semanas), o footer/relatório avisa; repita o
setup.

## Uso

- **Footer**: `Qwen pro 5h 84%↻4h 38m · weekly 86%↻6d 14h`
  (verde >20% restante, amarelo ≤20%, vermelho ≤10%) — atualiza após cada
  turno do agente (cache de 90s)
- **`/qwen-usage`**: relatório detalhado com barras e créditos absolutos

## Notas

- Funciona em qualquer OS (testado em Windows; usa só `fetch` + fs)
- Não depende do `qwencloud` CLI
- Se a assinatura for Team Edition, o formato das APIs é diferente — esta
  extensão cobre a edição **Individual**

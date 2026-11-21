# Decky Torrent

Plugin experimental para o Steam Deck. A Loja lista pacotes BitTorrent por categoria e permite pesquisar pelo título. Downloads acompanha as transferências em tela cheia e permite pausar e continuar. O painel inicial reúne os pacotes concluídos com um executável Windows para adicionar à biblioteca.

## Trocar de loja

Disponível a partir da **v0.2.7**. No Modo Jogo, abra **Decky Torrent → Loja → Trocar de loja**. O campo mostra o repositório em uso. Cole a URL de um repositório público, como `https://github.com/seu-usuario/minha-loja`, e clique em **Salvar loja**.

O plugin procura `catalogo.json` na raiz da branch padrão do repositório e lê as capas pelos caminhos do campo `imagem`. Se o catálogo estiver ausente ou inválido, a loja anterior continua ativa. A escolha fica salva no Steam Deck e os downloads existentes permanecem na fila. Para voltar ao catálogo original, selecione **Usar loja padrão**.

Ao reabrir o painel, o plugin consulta o catálogo remoto. Se o GitHub estiver indisponível, a Loja usa a última versão válida salva. As capas remotas dependem da rede e exibem um ícone quando indisponíveis. A Loja também tenta descobrir o tamanho pelos metadados dos magnets exibidos e guarda o resultado após uma consulta bem-sucedida.

## Criar seu próprio catálogo

1. Crie um repositório **público** no GitHub e clone-o na sua máquina.
2. Crie `catalogo.json` na raiz, seguindo o exemplo abaixo, e guarde as capas em `imagens/`. Use conteúdos próprios ou que você tenha autorização para distribuir.
3. Publique o JSON e as capas na **branch padrão** do seu repositório. Se ela for `main`, você pode usar os comandos abaixo.
4. No Steam Deck, abra **Loja → Trocar de loja** e cole a URL do seu repositório. A instalação existente do Decky Torrent pode usar esse catálogo.

```bash
git add catalogo.json imagens/
git commit -m "Publica catálogo da loja"
git push origin main
```

### Estrutura do repositório

```text
minha-loja/
├── catalogo.json
└── imagens/
    └── app-demo.webp
```

Exemplo de `catalogo.json`:

```json
{
  "categorias": [
    { "id": "aplicativos", "nome": "Aplicativos" }
  ],
  "pacotes": [
    {
      "id": "app-demo",
      "nome": "Aplicativo de teste",
      "magnet": "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
      "imagem": "imagens/app-demo.webp",
      "categoria": "aplicativos"
    }
  ]
}
```

- Troque o magnet de exemplo pelo link real do seu pacote. O plugin aceita o info hash BitTorrent v1 com 40 caracteres em hexadecimal ou 32 em Base32.
- Use IDs únicos de até 64 caracteres, com letras minúsculas, números, hífen ou sublinhado, começando por uma letra ou número. Em cada pacote, `categoria` deve corresponder ao ID de uma categoria. Preserve os IDs ao renomear itens.
- O JSON remoto tem limite de 1 MiB. O campo `imagem` é relativo à raiz e deve apontar para uma capa PNG, JPEG ou WebP. A Loja aceita `imagens/`, `images/` e `image/`. Para usar o editor e o monitor de publicação, use `imagens/`.

### Editar pelo navegador

Use a página [`editor/index.html`](editor/index.html) incluída no projeto. Se quiser manter o editor junto do seu catálogo, copie a pasta `editor/` para o seu clone. No Chrome ou Edge, abra a página pelo gerenciador de arquivos, clique em **Vincular pasta do projeto**, selecione a raiz que contém o seu `catalogo.json` e autorize a gravação. **Salvar pacote** grava o JSON e a capa diretamente nessa pasta. Vincule a pasta novamente se reabrir a página.

Em navegadores sem acesso direto à pasta, use **Importar catálogo** para abrir o JSON e **Carregar pasta de capas** para carregar `imagens/`. Depois de editar, escolha **Exportar ZIP**, extraia na raiz do repositório e mantenha as capas que você não carregou no editor. Em seguida, faça commit e push.

### Publicar automaticamente ao salvar

No Linux ou SteamOS, copie [`scripts/publicar-catalogo.py`](scripts/publicar-catalogo.py) para a pasta `scripts/` do seu clone. Com o Git autenticado e a branch local `main` sincronizada com `origin/main`, execute na raiz:

```bash
python3 scripts/publicar-catalogo.py
```

Vincule essa mesma pasta no editor. Enquanto o monitor estiver aberto, ele faz commit e push do catálogo e das capas referenciadas quando você salva. O terminal mostra o resultado. Use `Ctrl+C` para parar ou execute `python3 scripts/publicar-catalogo.py --once` para publicar alterações já gravadas.

## Instalar pelo Decky

Copie `decky-torrent-v0.2.7.zip` para o Steam Deck. Nas configurações do Decky, habilite o modo de desenvolvedor e abra **Desenvolvedor → Instalar plugin de arquivo ZIP**. Selecione o ZIP inteiro. O pacote de instalação inclui o `aria2c` para Linux x86-64. Se estiver vindo da versão Catálogo Decky, reinicie o Steam Deck após instalar para que o Decky recarregue o plugin com o novo nome. O instalador mantém a pasta interna da versão anterior.

A loja padrão consulta o `catalogo.json` da branch `main` de [markuusbrdev/deckytorrent](https://github.com/markuusbrdev/deckytorrent). Na primeira abertura sem acesso ao GitHub, o plugin usa o catálogo incluído no ZIP.

## Gerar o ZIP localmente

```bash
npm ci
npm run typecheck
npm run build
python3 scripts/package-plugin.py --aria2 /caminho/para/aria2c --aria2-source /caminho/para/aria2-fontes.tar
```

Forneça um `aria2c` x86-64 portátil e o pacote de fontes correspondente. O instalador é gerado em `release/`.

## Testar no Steam Deck

1. Abra **Loja**, escolha uma categoria e selecione a capa do pacote. Escolha uma pasta. O plugin cria uma subpasta exclusiva para o pacote.
2. Abra **Downloads**, pause, continue e feche o painel. Ao reabrir, confira o progresso. O backend guarda a fila e o aria2 preserva os dados parciais para retomada.
3. Ao terminar, confira a notificação e o estado **Concluído** em Downloads. O aria2 usa `--seed-time=0`. Pode haver upload durante o download.
4. Reabra o painel do **Decky Torrent**, escolha **Adicionar à Steam** e selecione o `.exe` do pacote. Confira o atalho na biblioteca. Para executar um programa Windows no SteamOS, habilite o Proton nas propriedades do atalho conforme necessário.

A fila do plugin funciona em segundo plano enquanto o Deck está acordado. Reiniciar o backend interrompe a transferência até que ele recarregue o estado. A API de atalhos pertence ao cliente Steam e deve ser validada na versão do SteamOS usada no teste.

Na tela **Downloads**, **Apagar** pede confirmação. Para downloads incompletos, a confirmação cancela a transferência e exclui a subpasta do pacote. Para concluídos, a confirmação remove a entrada da fila e mantém os arquivos e atalhos.

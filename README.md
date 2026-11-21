# Decky Torrent

Plugin experimental para o Steam Deck. A Loja lista pacotes BitTorrent por categoria e permite pesquisar pelo título. Downloads acompanha as transferências em tela cheia e permite pausar e continuar. O painel inicial reúne os pacotes concluídos com um executável Windows para adicionar à biblioteca.

## Configurar a Loja

### Editar pelo navegador

Abra `editor/index.html` pelo gerenciador de arquivos. No Chrome ou Edge, clique em **Vincular pasta do projeto**, selecione a raiz que contém `catalogo.json` e autorize a gravação. **Salvar pacote** grava o JSON e a capa nessa pasta. Criar uma categoria ou remover um pacote também atualiza o JSON. Vincule a pasta novamente se reabrir a página. As alterações ficam nos arquivos locais, prontos para commit.

Em navegadores sem acesso direto à pasta, use **Importar catálogo** para abrir o JSON e **Carregar pasta de capas** para carregar `imagens/`. Depois de salvar os pacotes na página, use **Exportar ZIP**, extraia os arquivos na raiz do repositório e mantenha as capas que você não carregou no editor. A exportação também está disponível com a pasta vinculada.

### Formato dos arquivos

Cadastre conteúdos próprios ou que você tenha autorização para distribuir. Cada entrada em `catalogo.json` deve ter estes campos:

| Campo | Valor de exemplo |
| --- | --- |
| `id` | `app-demo` |
| `nome` | `Aplicativo de teste` |
| `magnet` | `magnet:?xt=urn:btih:HASH_DO_TORRENT&tr=TRACKER_CODIFICADO` |
| `imagem` | `imagens/app-demo.webp` |
| `categoria` | `aplicativos` |

Substitua o hash por um info hash BitTorrent v1, com 40 caracteres em hexadecimal ou 32 em Base32. Guarde a capa em `imagens/` e publique o catálogo e a pasta juntos. Preserve os IDs ao alterar os nomes exibidos.

O campo `urlCatalogo` em `configuracao.json` aponta para a URL Raw do JSON no GitHub. Atualize esse campo se mudar a branch ou o repositório. A cada abertura do painel, o plugin consulta essa URL. Ele reutiliza a última versão válida do JSON se o GitHub estiver indisponível. As capas remotas dependem da rede e têm um ícone de reserva. Com a URL vazia, a Loja usa o catálogo e as capas locais incluídos no plugin.

A Loja tenta descobrir o tamanho pelos metadados de cada magnet exibido. O tamanho fica em cache depois da primeira consulta bem-sucedida. Se os metadados estiverem indisponíveis, ainda é possível escolher a pasta e iniciar o download.

## Instalar pelo Decky

Copie `decky-torrent-v0.2.6.zip` para o Steam Deck. Nas configurações do Decky, habilite o modo de desenvolvedor e abra **Desenvolvedor → Instalar plugin de arquivo ZIP**. Selecione o ZIP inteiro. O pacote de instalação inclui o `aria2c` para Linux x86-64. Se estiver vindo da versão Catálogo Decky, reinicie o Steam Deck após instalar para que o Decky recarregue o plugin com o novo nome. O instalador mantém a pasta interna da versão anterior.

O plugin consulta o `catalogo.json` da branch `main` de [markuusbrdev/deckytorrent](https://github.com/markuusbrdev/deckytorrent). Enquanto o arquivo remoto estiver indisponível, a Loja usa o catálogo incluído no ZIP ou a última versão válida em cache.

## Gerar o ZIP localmente

```bash
npm ci
npm run typecheck
npm run build
python3 scripts/package-plugin.py --aria2 /caminho/para/aria2c --aria2-source /caminho/para/aria2-fontes.tar
```

Forneça um `aria2c` x86-64 portátil e o pacote de fontes correspondente. O instalador é gerado em `release/`.

## Testar no Steam Deck

1. Abra **Loja**, escolha uma categoria e selecione **Baixar**. Escolha uma pasta. O plugin cria uma subpasta exclusiva para o pacote.
2. Abra **Downloads**, pause, continue e feche o painel. Ao reabrir, confira o progresso. O backend guarda a fila e o aria2 preserva os dados parciais para retomada.
3. Ao terminar, confira a notificação e o estado **Concluído** em Downloads. O aria2 usa `--seed-time=0`. Pode haver upload durante o download.
4. Reabra o painel do **Decky Torrent**, escolha **Adicionar à Steam** e selecione o `.exe` do pacote. Confira o atalho na biblioteca. Para executar um programa Windows no SteamOS, habilite o Proton nas propriedades do atalho conforme necessário.

A fila do plugin funciona em segundo plano enquanto o Deck está acordado. Reiniciar o backend interrompe a transferência até que ele recarregue o estado. A API de atalhos pertence ao cliente Steam e deve ser validada na versão do SteamOS usada no teste.

Na tela **Downloads**, **Apagar** pede confirmação. Para downloads incompletos, a confirmação cancela a transferência e exclui a subpasta do pacote. Para concluídos, a confirmação remove a entrada da fila e mantém os arquivos e atalhos.

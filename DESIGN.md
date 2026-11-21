# Decky Torrent

Painel lateral de operação em português brasileiro para o Steam Deck. O painel inicial privilegia o último passo, com ícones independentes de Loja e Downloads no cabeçalho e cartões compactos para cada download pronto para adicionar à biblioteca. A pasta e o tamanho ficam em texto secundário abaixo do título.

A Loja e Downloads abrem como telas do Modo Jogo. A Loja usa capas em proporção 4:5 numa grade, com título e tamanho abaixo, sem moldura externa. Cada capa é um único alvo de foco, indicado pelo brilho da arte e pelo título sublinhado. Downloads usa linhas de transferência e uma barra em ciano (`#86d5f4`). As telas usam fundo `#101922`, cartões `#22303e` e texto secundário `#b9c9d8`. Os estilos ficam em `src/styles.ts`. A navegação, os botões, o seletor de categoria, o seletor de arquivos e as notificações usam os componentes do Decky e da Steam.

## Editor de catálogo no navegador

Ferramenta local para quem mantém os arquivos da Loja. Em telas largas, o formulário fica ao lado da lista com miniaturas. Em telas estreitas, os painéis seguem a rolagem da página. O CSS do editor usa fundo grafite (`#171a1b`), superfícies `#222728`, texto marfim (`#f4f1e8`) e âmbar (`#ffd482`) para ações principais, foco e seleção. Tipografia do sistema com fonte monoespaçada nos magnets. A prévia reserva 96 × 72 px.

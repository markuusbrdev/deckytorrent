# Catálogo Decky

Painel lateral de operação em português brasileiro para quem navega pelo Modo Jogo com controle ou toque. A Loja usa capas pequenas ao lado da identificação do pacote, como na biblioteca, e Meus downloads prioriza o estado e a barra de progresso.

A tipografia, o fundo do painel, a rolagem, o foco, as linhas e os botões vêm dos componentes do Decky e da Steam. A interface ocupa uma coluna, com duas abas lado a lado e ações de largura total por item. As capas reservam 60 × 45 px, inclusive quando falham. O fundo da capa usa `#263444`, detalhes de leitura usam `#b7cede` e o progresso usa `#77c9ef`. Esses valores são aplicados em `src/index.tsx`.

O painel usa os pop-ups do Decky para os filtros e seletores de arquivos e o sistema de notificações do Decky para conclusão. A fila continua visível com o último estado conhecido se a consulta falhar.

## Editor de catálogo no navegador

Ferramenta local para quem mantém os arquivos da Loja. Em telas largas, o formulário fica ao lado da lista com miniaturas. Em telas estreitas, os painéis seguem a rolagem da página. O CSS do editor usa fundo grafite (`#171a1b`), superfícies `#222728`, texto marfim (`#f4f1e8`) e âmbar (`#ffd482`) para ações principais, foco e seleção. Tipografia do sistema com fonte monoespaçada nos magnets. A prévia reserva 96 × 72 px.

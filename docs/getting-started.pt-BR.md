# Guia inicial

[English](getting-started.md) · **Português**

> **Ainda não executável.** O `@struct8/hub` não foi publicado, e o núcleo e o runtime da Lambda
> ainda estão sendo escritos. Esta página descreve o fluxo que está sendo construído, e serve
> também como especificação do que essas peças têm que entregar. O aviso sai quando a primeira
> versão for publicada.

---

## O que você vai ter em cinco minutos

Um diagrama com três nós e dois fios, implantado, com uma mensagem atravessando de ponta a ponta,
e um relatório dizendo qual fio a carregou.

```
  ┌──────────┐        orders        ┌──────────┐
  │   Fila   │ ───────────────────▶ │  Função  │
  └──────────┘                      └────┬─────┘
                                         │ archive
                                         ▼
                                   ┌──────────┐
                                   │  Bucket  │
                                   └──────────┘
```

## 1. Desenhe

No Struct8: uma fila, uma função, um bucket. Ligue a fila na função, e a função no bucket. Escreva
`archive` no segundo fio — o rótulo entra no relatório, e é como você distingue dois fios que vão
para o mesmo alvo.

Nada mais. Sem código, sem permissão, sem variável de ambiente. É para isso que servem os fios.

## 2. Implante

O gerador emite a infraestrutura e preenche a função com um arquivo assim:

```js
import { hub } from '@struct8/hub';
import '@struct8/hub/r/aws_sqs_queue';
import '@struct8/hub/r/aws_s3_bucket';

export const handler = hub.lambda();
```

Você não escreve esse arquivo, mas vale ler uma vez. Os dois imports de recurso são exatamente os
dois tipos do seu diagrama — nada além disso é embarcado. E não existe lista de destinos: a função
acha o bucket lendo o próprio ambiente, que o gerador preencheu a partir do fio.

## 3. Mande alguma coisa

Coloque uma mensagem na fila.

## 4. Leia o relatório

```json
{
  "trace": "01JQ8F2K7VN3",
  "origin": "aws:sqs",
  "hops": [
    { "n": 1, "to": "my-archive-bucket", "type": "aws_s3_bucket",
      "label": "archive", "ok": true, "ms": 41 }
  ]
}
```

Uma linha por fio que a mensagem de fato atravessou. O `label` é o texto que você digitou no fio —
é o que liga o relatório de volta ao desenho.

Falha é relatada, não lançada:

```json
{ "n": 1, "to": "my-archive-bucket", "type": "aws_s3_bucket",
  "label": "archive", "ok": false, "ms": 12,
  "err": "AccessDenied: s3:PutObject" }
```

Os outros destinos continuam recebendo a cópia deles. Um fio quebrado não derruba o resto.

## O que tentar depois

**Puxe um segundo fio da função para o mesmo bucket**, com outro rótulo. Os dois disparam. O
diagrama desenhou dois fios, então acontecem duas coisas — é a regra, e ela surpreende uma vez até
você ver funcionando.

**Apague um fio e reimplante.** O destino some do relatório sem ninguém editar código. Quem
configura é o fio; nunca houve uma lista para atualizar.

**Quebre de propósito.** Tire a permissão do bucket e mande de novo. O relatório nomeia o fio e o
motivo. É para esse modo que a ferramenta existe: não para provar que um diagrama certo está
certo, mas para descobrir rápido qual pedaço de um errado está errado.

## Onde a fiação está escrita

Tudo acima se apoia num acordo só entre o gerador e o código: como um fio vira variável de
ambiente. É o [CONTRACT.md](../CONTRACT.md), versionado, e independente desta implementação — se
você preferir escrever o seu próprio hub, aquele documento basta. *(em inglês)*

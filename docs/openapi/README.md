# OpenAPI 3.1

`openapi.yaml`をOpenAPI 3.1仕様のルートドキュメントとする。Git上で差分をレビューしやすくするため、Path Itemとcomponent schemaは外部`$ref`ファイルへ分割している。

この構成は、Google Docsから移行した単一OpenAPIドキュメントの意味を維持したまま、リポジトリで保守しやすい形へ分割したものである。

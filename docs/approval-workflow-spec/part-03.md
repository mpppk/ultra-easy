# **4\. パッケージ構成と依存方向**

packages/  
  approval-core/  
    action/  
    schema/  
    policy/  
    flow/  
    authorization/  
  approval-runtime-cloudflare/  
  approval-fga/  
  approval-d1/  
  approval-mcp/  
  organization/  
apps/  
  approval-api/  
  approval-mcp-server/

| パッケージ | 役割 | 主な依存 |
| :---- | :---- | :---- |
| @app/approval-core | ドメインモデル、Policy/Flow AST、Builder、PolicyBindingResolver/Evaluator/ApprovalPlanCompiler、Flow semantics、Authorization/Execution ports | @standard-schema/spec（型/API契約のみ） |
| @app/approval-fga | ActionAuthorizer / ApproverResolverのAuth0 FGA実装 | approval-core, Web Fetch API |
| @app/approval-d1 | 業務データ、監査event、pending-task projection、final result、outbox | approval-core, drizzle-orm |
| @app/organization | 組織マスタとFGA Projection | DB \+ FGA adapter |
| approval-api | HTTP境界とApplication Service | 上記各package |

## **4.1 Cloudflare Runtime Adapter** **@app/approval-runtime-cloudflare はGeneric ActionWorkflow、Flow InterpreterのCloudflare adapter、DurableRuntime実装を提供する。approval-coreへ依存するが、approval-coreからは依存しない。ユーザー定義Flow ASTを実行するWorkflow classは1種類とし、申請ごとに独立instanceを作成する。** **禁止事項  approval-coreからCloudflare Workflows API、@openfga/sdk、drizzle-orm、zod、valibot、arktype等を直接importしない。**

## **4.2 MCP / Input Adapter**

# **@app/approval-mcpはMCP requestをActionRequestへ正規化し、ActionAuthorizer / Approval Policy / Generic ActionWorkflowへ接続するAdapterを提供する。MCP method/tool/argumentsやclient metadataをcoreへ直接漏らさず、origin/actionへ変換する。MCP Tasks extensionを利用する場合もTask lifecycleはprotocol projectionとしてこのpackageで扱う。**

# **HTTP/UI/System Triggerも同じ方針でInput Adapterを実装し、coreのActionRequest contractへ変換する。Adapter固有のsession、requestState、task handle、transport errorはapproval-coreのPolicy/Flow ASTへ含めない。**

#

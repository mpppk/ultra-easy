# **16. 外部インターフェース境界（詳細APIは別OpenAPI仕様） — Part 2**

## **16.1 MCP Adapter / Protocol Projection**

# **MCPはActionRequestへの入力Adapterとして扱い、MCP callそのものを別の承認domain resourceにはしない。MCP Adapterは認証済みprincipal/client、MCP method/tool名、arguments、利用可能であれば信頼できるagent identity/run identityをActionRequestへ正規化する。2026-07-28 Streamable HTTPではMcp-Method / Mcp-Nameをgateway routing/early authorizationに利用できるが、最終Authorizationはbodyとの整合性およびActionAuthorizerで再検証する。**

# **MCP標準は論理的なagent identityを完全には規定しないため、agentId/agentRunIdを任意のtool argumentや未検証headerから信用してはならない。Agent identityを利用する場合は、認証済みclientとのbinding、署名済みmetadata、Enterprise Managed Authorization等、deploymentで信頼境界を定義する。対話型Agentではauthority.principal/delegator/callerを現在の人間resource ownerへ結び付け、自律Agentではservice principal等の独立authorityを利用できる。**

# **MCP access tokenはMCP server向けresource tokenとして扱い、下流APIへそのままpassthroughしない。下流resourceへの実行は、そのresource向けcredential/delegated tokenとAction Authorizationを用いる。**

# 

## **16.2 MCPでの承認待機表現**

#  **tools/callがAuthorizationを通過しApproval Flowを必要とする場合、domain側では通常のActionRequest \+ Generic ActionWorkflowを開始する。MCP clientがio.modelcontextprotocol/tasks extensionをadvertiseしている場合、MCP AdapterはそのActionRequestをMCP Taskとしてprojectionし、task handleを返す。MCP Taskはprotocol projectionであり、domainのSource of Truthではない。**

# **caller()承認のように現在のMCP callerから入力が必要な場合、Taskのinput\_required / tasks/update、または短い単発確認ではMRTRのinput\_requiredを利用できる。manager/finance等の第三者承認ではclient inputを要求せずTaskをpending/workingとして維持し、外部承認完了後にWorkflowを再開してTask結果へ反映する。**

# **2026-07-28時点でtask-augmented executionの標準対象はtools/callのみである。v1では承認待ちを伴うMCP integrationをtools/callに限定し、resources/read等の他methodはallow/denyまたは通常のauthorization step-upとして扱う。将来Tasks extensionの対象methodが拡張された場合にAdapterのみで追随できるよう、coreはMCP methodへ依存しない。**

#

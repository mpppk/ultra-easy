# **付録A. Policy JSON例**

{  
  "schemaVersion": 1,  
  "key": "expense",  
  "name": "経費申請",  
  "rules": \[  
    {  
      "key": "under-500k",  
      "when": {  
        "type": "comparison",  
        "left": { "type": "field", "path": "action.input.amount" },  
        "operator": "lt",  
        "right": { "type": "literal", "value": 500000 }  
      },  
      "flow": {  
        "type": "approval",  
        "key": "manager",  
        "name": "部長承認",  
        "resolution": "dynamic",  
        "selfApproval": { "mode": "deny", "subject": { "type": "authority\_principal" } },  
        "approver": {  
          "type": "relation",  
          "object": {  
            "type": "reference",  
            "objectType": "org\_unit",  
            "id": { "type": "field", "path": "action.input.orgUnitId" }  
          },  
          "relation": "manager"  
        }  
      }  
    },  
    {  
      "key": "over-500k",  
      "when": {  
        "type": "comparison",  
        "left": { "type": "field", "path": "action.input.amount" },  
        "operator": "gte",  
        "right": { "type": "literal", "value": 500000 }  
      },  
      "flow": {  
        "type": "serial",  
        "children": \[  
          {  
            "type": "approval",  
            "key": "manager",  
            "approver": {  
              "type": "relation",  
              "object": {  
                "type": "reference",  
                "objectType": "org\_unit",  
                "id": { "type": "field", "path": "action.input.orgUnitId" }  
              },  
              "relation": "manager"  
            }  
          },  
          {  
            "type": "approval",  
            "key": "division-manager",  
            "approver": {  
              "type": "relation",  
              "object": {  
                "type": "reference",  
                "objectType": "org\_unit",  
                "id": { "type": "field", "path": "action.input.orgUnitId" }  
              },  
              "relation": "parent\_manager"  
            }  
          }  
        \]  
      }  
    }  
  \]  
}

# **付録B. TypeScript Builder例**

const expensePolicy \= definePolicy({  
  key: "expense",  
  name: "経費申請",  
  rules: \[  
    rule("normal", {  
      when: lt(field("action.input.amount"), literal(500\_000)),  
      flow: approve({  
        key: "manager",  
        selfApproval: { mode: "deny", subject: authorityPrincipal() },  
        approver: relation({  
          object: object("org\_unit", field("action.input.orgUnitId")),  
          relation: "manager",  
        }),  
      }),  
    }),  
    rule("large", {  
      when: gte(field("action.input.amount"), literal(500\_000)),  
      flow: serial(  
        approve({  
          key: "manager",  
          approver: relation({  
            object: object("org\_unit", field("action.input.orgUnitId")),  
            relation: "manager",  
          }),  
        }),  
        approve({  
          key: "division-manager",  
          approver: relation({  
            object: object("org\_unit", field("action.input.orgUnitId")),  
            relation: "parent\_manager",  
          }),  
        }),  
      ),  
    }),  
  \],  
});

// expensePolicyは単なるJSON serializable AST  
JSON.stringify(expensePolicy);

# **付録C. FGAモデル例**

model  
  schema 1.1

type user  
  relations  
    define manager: \[user\]

type agent  
type service

type organization  
  relations  
    define finance\_approver: \[user\]  
    define executive\_approver: \[user\]

type org\_unit  
  relations  
    define organization: \[organization\]  
    define parent: \[org\_unit\]  
    define member: \[user\]  
    define manager: \[user\]  
    define delegated\_manager: \[user with active\_period\]

    define effective\_manager: manager or delegated\_manager  
    define parent\_manager: effective\_manager from parent  
    define ancestor\_manager: effective\_manager or ancestor\_manager from parent  
    define finance\_approver: finance\_approver from organization  
    define executive\_approver: executive\_approver from organization

condition active\_period(  
  current\_time: timestamp,  
  valid\_from: timestamp,  
  valid\_until: timestamp  
) {  
  current\_time \>= valid\_from &&  
  current\_time \< valid\_until  
}

resource authorizationでAI AgentやServiceへ直接権限を付与する場合は、対象resourceのrelationに \[user, agent, service\] 等を許可し、ActionAuthorizerがauthority.principalの型に応じてCheckする。人間からAgentへ委譲する場合は、元principalのresource authorizationとDelegationHop chainの制約をANDし、Approvalによって不足権限を補完してはならない。

実際のAuthorization Modelでは再帰relationの性能・複雑性をテストし、組織階層が固定的なら明示relationに簡略化すること。

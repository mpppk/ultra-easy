# **12. Authorization / ApproverResolver / Auth0 FGA連携**

## **12.0 ActionAuthorizer / Effective Authority**

## **ActionAuthorizerはApprovalとは独立した前段Portとし、ActionRequestが承認Flowへ進む資格を判定する。承認は権限昇格手段ではなく、AuthorizationでdenyされたActionRequestをApprovalでallowへ変換してはならない。**

## 

## **type AuthorizationEvidence \= {**

##   **evaluatedAt: string;**

##   **provider?: string;**

##   **contextChecksum?: string;**

## **};**

## 

## **type AuthorizationResult \=**

##   **| { type: "allow"; evidence: AuthorizationEvidence }**

##   **| { type: "deny"; code: string; reason: string }**

##   **| { type: "error"; retriable: boolean; code: string; message: string };**

## 

## **export interface ActionAuthorizer {**

##   **check(input: {**

##     **request: ActionRequest;**

##     **evaluatedAt: string;**

##     **consistency?: "minimize\_latency" | "higher\_consistency";**

##   **}): Promise\<AuthorizationResult\>;**

## **}**

## 

## 

## **AI Agentのauthorityは2種類を区別する。①agent/service自身へresource権限を直接付与するdirect authority、②user/service等のprincipalからDelegationHop chainで限定委譲するdelegated authorityである。実効権限はauthority.principalの現在権限、認証token scope、delegation grant、agent固有制約、organization policyの積集合として扱う。delegationは原則attenuationのみ許可し、delegateeがdelegatorより強い権限を得てはならない。AI作成者と現在callerが異なる場合もcreator/caller/authority/delegatorを別PrincipalRefとして保持する。ActionAuthorizerは受付時だけでなく、すべての承認Flow完了後・ActionExecutor実行直前にも再実行する。**

## 

## **12.0.1 Shared Attribute Context とApproval/OpenFGAの責務境界**

## **Approval PolicyとAuthorization/OpenFGAはamount、currency、resource type、risk classification、organization settings、time等の同じ属性を参照してよいが、意味論は共有しない。共通化するのはActionRequest \+ EvaluationSnapshot \+ derived attributesからなるAttribute Contextの構築までとする。Approval Conditionは「追加承認が必要か／どのFlowか（WHEN/WHAT）」を返し、OpenFGA Model/Conditionは「誰が現在その操作または承認を行えるか（WHO）」を返す。Approval Condition ASTをOpenFGA CELへ自動compileすることはv1の標準機能にしない。**

## **同じ閾値に見えても「50万円以上なら部長承認」と「Bobは50万円まで承認可能」は別のbusiness ruleであり個別管理する。一方\`riskClass=large\`等、本当に同一概念を両者が利用する場合はAction Definition側でderived attributeを一度計算し、Approval Policyには\`attributes.riskClass\`、OpenFGAには同等のrequest contextとして供給する。OpenFGA Conditionへ渡すrequest-time attributeも監査再現に必要なものはEvaluationSnapshotまたはAuthorizationEvidenceのchecksumで追跡可能にする。**

## 

## **12.1 Port**

export interface ApproverResolver {  
  check(input: {  
    target: ResolvedApproverTarget;  
    userId: string;  
    context?: Record\<string, unknown\>;  
    consistency?: "minimize\_latency" | "higher\_consistency";  
  }): Promise\<boolean\>;

  list(input: {  
    target: ResolvedApproverTarget;  
    context?: Record\<string, unknown\>;  
    consistency?: "minimize\_latency" | "higher\_consistency";  
  }): Promise\<{ userIds: string\[\]; complete: boolean }\>;  
}

type ResolvedApproverTarget \=  
  | {  
      type: "relation";  
      object: string;  
      relation: string;  
      sourceKind?: "relation" | "principal\_relation";  
    }  
  | {  
      type: "user";  
      userId: string;  
      sourceKind?: "principal" | "user";  
    };

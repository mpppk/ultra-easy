# **5\. Standard Schema統合仕様**

## **5.1 基本方針**

入力スキーマのruntime validationと型推論はStandardSchemaV1を契約とする。具体的なSchemaライブラリは利用アプリケーションが選択する。

import type { StandardSchemaV1 } from "@standard-schema/spec";

export interface SchemaResolver {  
  resolve(ref: SchemaReference):  
    | StandardSchemaV1  
    | Promise\<StandardSchemaV1\>;  
}

export type SchemaReference \= {  
  key: string;  
  version: number;  
};

## **5.2 Schema参照**

Action inputのSchemaはApproval PolicyではなくAction Definitionが所有する。複数の独立Policyを同一ActionRequestへ合成できるよう、Policy ASTからinputSchemaを分離する。Action Definitionはaction typeごとの不変バージョン付きcontractとし、SchemaReference、入力正規化規則、derived attributesの定義/Provider参照、Executor key等を保持できる。ActionRequest受付時に解決したAction Definition VersionとSchema Versionを固定し、actionFingerprintへAction Definition Versionを含める。Policyはaction.input/attributesを参照できるが、Field Catalogによる型検証は対象Action DefinitionのSchema/derived attribute catalogを使う。

type ActionDefinition \= {  
  key: string;  
  version: number;  
  actionType: string;  
  inputSchema: SchemaReference;  
  executorKey: string;  
  normalizationVersion?: number;  
  derivedAttributeCatalog?: PolicyFieldDefinition\[\];  
};

Published Action Definition Versionはimmutableとし、変更時は新versionを作成する。Action Definitionのpublishも基盤の実行意味・fingerprintへ影響するためmeta-approval対象にできる。

type ActionDefinition \= {  
  type: string;  
  inputSchema: SchemaReference;  
};

export interface ActionDefinitionResolver {  
  resolve(actionType: string):  
    | ActionDefinition  
    | Promise\<ActionDefinition\>;  
}

// 例  
{  
  "type": "expense.create",  
  "inputSchema": { "key": "expense-request", "version": 2 }  
}

## **5.3 Standard JSON Schemaは任意Capability**

GUI Policy EditorやField Catalog生成では構造のイントロスペクションが必要になる。StandardSchemaV1自体はvalidation契約であり、構造列挙を保証しないため、GUI関連APIのみStandardJSONSchemaV1を要求する。

| Capability | 要求interface | 用途 |
| :---- | :---- | :---- |
| Validation / inference | StandardSchemaV1 | 申請入力の検証、型推論 |
| JSON Schema conversion | StandardJSONSchemaV1 | GUIのfield discovery、フォーム生成、ドキュメント |

export interface FieldCatalogProvider {  
  getFields(schema: StandardJSONSchemaV1):  
    Promise\<PolicyFieldDefinition\[\]\>;  
}

// validationとJSON Schema生成を同一objectに要求する場合は  
// intersectionではなく「両traitを満たすgeneric constraint」を利用してよい。

## **5.4 Policy ASTとの分離**

Policy ASTそのものはStandard Schemaに依存しない。Action Definition / Standard Schemaは「action inputが正しいか」、Authorizationは「actor/authorityがそのactionを要求可能か」、Policy ASTは「追加承認が必要ならどのFlowを生成するか」、FGAはresource authorizationおよびrelation-based approver解決を担当する。

Action Definition \+ Standard Schema \-\> action input validation  
Action Authorization \-\> authority / delegation validation  
Policy JSON AST    \-\> approval flow selection  
Auth0 FGA          \-\> resource authorization / approver relation

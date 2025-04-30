// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/ or see the [LICENSE.md](https://github.com/networkoptix/nx_open_integrations/blob/master/license_mpl2.md) file for more details.


# Sample of [Nx SaaS Channel Partner REST API](https://meta.nxvms.com/partners/#/)


## Configure the system(s) through the [Nx SaaS Channel Partner REST API](https://meta.nxvms.com/partners/#/)

We offer a sample script to demonstrate the functionalities realized through leveraging the REST API calls. 
This script will serve as a starting point to understand how to interact with the SAAS backend through the specified APIs.


## What is "custom_id"

The custom_id is a user-defined, human-readable identifier utilized within Nx SaaS to provide enhanced flexibility and clarity for Channel Partners. It enables Nx SaaS customers, particularly those operating as Channel Partners, to efficiently execute API requests using these tailored identifiers.

The custom_id can be any string value sourced from external systems, such as third-party platforms or private CRM systems, enabling quick identification and differentiation of subordinate entities with internal linkages.

A Channel Partner Administrator has the capability to assign a custom_id to any entity under their management within the hierarchical structure, including _(Sub-)Channel Partners, Organizations, Cloud Systems, or Services_. The custom_id associated with the Channel Partner to which the current user belongs is both visible and editable by that user.

If an entity has been assigned a custom_id, it becomes possible to execute API requests using the Nx SaaS Channel Partners API by leveraging the fullId format, which combines the channel_partner_id and custom_id (i.e., _<channel_partner_id>--<custom_id>_).

Given the possibility of a chain of Channel Partners and their Sub Channel Partners, any entity within the hierarchy may potentially have multiple custom_ids. The maximum number of custom_ids for an entity corresponds to the number of Channel Partners in the path from that entity to the root node in the hierarchy.


## Function Highlights

This script demostrates the manuplation of a custom_id which allows the manager to attach the readable/3rd party system ideintifers to a target of Nx SaaS (i.e. Channel_partner, Organization, Cloud System, Services)

- **Add** a custom_id to a Channel Partner, Organization, Cloud System, or Service.
- **Delete** a custom_id to a Channel Partner, Organization, Cloud System, or Service.
- **Edit** the existing custom_id to a Channel Partner, Organization, Cloud System, or Service.
- **List** the custom_id information of a Channel Partner, Organization, Cloud System, or Service.


## Using the sample script
```bash
python3 custom_id_operation_sample.py {parent_cp_id} {operation} {target} {op_target_id} {custom_id} {custom_id} -u {USERNMAE} -p {PASSWORD}
```

Ex: 
[add the custom_id to a channel partner/organization/cloud_system/service]
```bash
python3 custom_id_operation_sample.py parent_cp_id_xxxx add channel_partner sub_cp_id_xxxx My_custom_ID  -u {USERNMAE} -p {PASSWORD}
python3 custom_id_operation_sample.py parent_cp_id_xxxx add organization organization_id_xxx My_custom_ID -u {USERNMAE} -p {PASSWORD}
python3 custom_id_operation_sample.py parent_cp_id_xxxx add cloud_system cloud_system_id_xxx My_custom_ID -u {USERNMAE} -p {PASSWORD}
python3 custom_id_operation_sample.py parent_cp_id_xxxx add service service_id_xxx My_custom_ID -u {USERNMAE} -p {PASSWORD}
```

[edit the custom_id of a channel partner/organization/cloud_system/service]
```bash
python3 custom_id_operation_sample.py parent_cp_id_xxxx edit channel_partner prev_custom_id new_custom_id -u {USERNMAE} -p {PASSWORD}
python3 custom_id_operation_sample.py parent_cp_id_xxxx edit organization prev_custom_id new_custom_id -u {USERNMAE} -p {PASSWORD}
python3 custom_id_operation_sample.py parent_cp_id_xxxx edit cloud_system prev_custom_id new_custom_id -u {USERNMAE} -p {PASSWORD}
python3 custom_id_operation_sample.py parent_cp_id_xxxx edit service prev_custom_id new_custom_id -u {USERNMAE} -p {PASSWORD}
```

[delete the custom_id of a channel partner/organization/cloud_system/service]
```bash
python3 custom_id_operation_sample.py parent_cp_id_xxxx delete channel_partner sub_cp_id_xxxx My_custom_ID -u {USERNMAE} -p {PASSWORD}
python3 custom_id_operation_sample.py parent_cp_id_xxxx delete organization organization_id_xxx My_custom_ID -u {USERNMAE} -p {PASSWORD}
python3 custom_id_operation_sample.py parent_cp_id_xxxx delete cloud_system cloud_system_id_xxx My_custom_ID -u {USERNMAE} -p {PASSWORD}
python3 custom_id_operation_sample.py parent_cp_id_xxxx delete service service_id_xxx My_custom_ID -u {USERNMAE} -p {PASSWORD}
```

[list all custom_ids of channel partner/organization/cloud_system/service under a channel_partner]
```bash
python3 custom_id_operation_sample.py parent_cp_id_xxxx list channel_partner -u {USERNMAE} -p {PASSWORD}
python3 custom_id_operation_sample.py parent_cp_id_xxxx list organization -u {USERNMAE} -p {PASSWORD}
python3 custom_id_operation_sample.py parent_cp_id_xxxx list cloud_system -u {USERNMAE} -p {PASSWORD}
python3 custom_id_operation_sample.py parent_cp_id_xxxx list service -u {USERNMAE} -p {PASSWORD}
```

[list the information of a custom_id assigned to a channel partner/organization/cloud_system/service under a channel_partner]
```bash
python3 custom_id_operation_sample.py parent_cp_id_xxxx list channel_partner My_custom_ID -u {USERNMAE} -p {PASSWORD}
python3 custom_id_operation_sample.py parent_cp_id_xxxx list organization My_custom_ID -u {USERNMAE} -p {PASSWORD}
python3 custom_id_operation_sample.py parent_cp_id_xxxx list cloud_system My_custom_ID -u {USERNMAE} -p {PASSWORD}
python3 custom_id_operation_sample.py parent_cp_id_xxxx list service My_custom_ID -u {USERNMAE} -p {PASSWORD}
```


### Authentication

This script uses an HTTP bearer/session token authentication. 
Please refer to [Nx Meta Authentication](https://support.networkoptix.com/hc/en-us/articles/4410505014423-Nx-Meta-Authentication) for more information.


## Example

**Imagine the following case:**:

- **Nx EVOS** is the top-layer (root) Channel Partner.
- **CompanyXYZ** is a Sub Channel Partner of Nx.
- **First Customer** is an entity of Organization of CompanyXYZ.
- **Pioneer** is a system managed by First Customer.
- **Recording** is a service enabled on Pioneer.

**The architecture of the entities is as follows:**

- Root Channel Partner (Nx EVOS)
- Sub Channel Partner (CompanyXYZ, custom_id = Associated_Id_from_Nx_CRM)
- Organization (First Org, custom_id = Associated_Id_of_First_Org_from_CompanyXYZ_CRM)
- Cloud System (Pioneer, custom_id = Associated_Id_from_First_Org_administrator)
- Service (Recording, custom_id = Associated_Product_SKU_from_CompanyXYZ)

**Entity IDs:**

- Root Channel Partner (Nx EVOS) = `9f70b051-61d2-4b07-8058-4c6e71982871`
- Sub Channel Partner (CompanyXYZ) = `8e6c1b22-518d-4439-9aee-33f87b558795`
- Organization (First Org) = `690ac1f2-c769-43a3-84f0-aa47a7f43df6`
- Cloud System (Pioneer) = `862e7db3-4479-4682-96d4-e04b26cc83bf`
- Service (Recording) = `64479718-0dd9-4a4e-b006-6ed090611c67`


### Steps to Assign Custom IDs

1. **Nx EVOS assigns a custom ID for CompanyXYZ** (custom_id = Associated_Id_from_Nx_CRM):

    ```bash
    python3 custom_id_operation_sample.py 9f70b051-61d2-4b07-8058-4c6e71982871 add channel_partner 8e6c1b22-518d-4439-9aee-33f87b558795 'Associated_Id_from_Nx_CRM' -u cloud_account@networkoptix.com -p cloud_account_password
    ```

    ```json
    {
        "customId": "Associated_Id_from_Nx_CRM",
        "channelPartner": "8e6c1b22-518d-4439-9aee-33f87b558795",
        "fullId": "9f70b051-61d2-4b07-8058-4c6e71982871--Associated_Id_from_Nx_CRM",
        "created": "2024-10-17T10:53:48.602083Z"
    }
    ```

2. **CompanyXYZ assigns a custom ID for First Org** (custom_id = Associated_Id_of_First_Org_from_CompanyXYZ_CRM):

    ```bash
    python3 ./custom_id_operation_sample.py 8e6c1b22-518d-4439-9aee-33f87b558795 add organization 690ac1f2-c769-43a3-84f0-aa47a7f43df6 'Associated_Id_of_First_Org_from_CompanyXYZ_CRM' -u cloud_account@networkoptix.com -p cloud_account_password
    ```

    ```json
    {
        "customId": "Associated_Id_of_First_Org_from_CompanyXYZ_CRM",
        "organization": "690ac1f2-c769-43a3-84f0-aa47a7f43df6",
        "fullId": "8e6c1b22-518d-4439-9aee-33f87b558795--Associated_Id_of_First_Org_from_CompanyXYZ_CRM",
        "created": "2024-10-17T10:54:11.878491Z"
    }
    ```

3. **CompanyXYZ assigns a custom ID for Pioneer** (custom_id = Associated_Id_provided_by_First_Org_administrator):

    ```bash
    python3 ./custom_id_operation_sample.py 8e6c1b22-518d-4439-9aee-33f87b558795 add cloud_system 862e7db3-4479-4682-96d4-e04b26cc83bf 'Associated_Id_provided_by_First_Org_administrator' -u cloud_account@networkoptix.com -p cloud_account_password 
    ```

    ```json
    {
        "customId": "Associated_Id_provided_by_First_Org_administrator",
        "cloudSystemId": "862e7db3-4479-4682-96d4-e04b26cc83bf",
        "fullId": "8e6c1b22-518d-4439-9aee-33f87b558795--Associated_Id_provided_by_First_Org_administrator",
        "created": "2024-10-17T10:54:41.727706Z"
    }
    ```

4. **CompanyXYZ assigns a custom ID for the service purchased by Pioneer** (custom_id = Associated_Product_SKU_from_CompanyXYZ):

    ```bash
    python3 ./custom_id_operation_sample.py 8e6c1b22-518d-4439-9aee-33f87b558795 add service 64479718-0dd9-4a4e-b006-6ed090611c67 'Associated_Product_SKU_from_CompanyXYZ' -u cloud_account@networkoptix.com -p cloud_account_password
    ```

    ```json
    {
        "customId": "Associated_Product_SKU_from_CompanyXYZ",
        "channelPartnerService": "64479718-0dd9-4a4e-b006-6ed090611c67",
        "fullId": "8e6c1b22-518d-4439-9aee-33f87b558795--Associated_Product_SKU_from_CompanyXYZ",
        "created": "2024-10-17T10:55:01.836846Z"
    }
    ```
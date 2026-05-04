<!DOCTYPE html>
<html>
<head><title>Users</title></head>
<body>
    <h1>User list</h1>

    <cfquery name="getUsers" datasource="appdb">
        SELECT id, name FROM users
    </cfquery>

    <cfoutput query="getUsers">
        <p>#name#</p>
    </cfoutput>

    <cfscript>
        var x = 1;
        var y = "<cfquery name='nope'>not really</cfquery>";
    </cfscript>

    <cfquery name="getCount" datasource="appdb">
        SELECT COUNT(*) AS cnt FROM users
    </cfquery>
</body>
</html>

// ================================================================
// src/hooks/use-children.ts - VERSIÓN REFACTORIZADA
// ================================================================

'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createClient, userCanAccessChild, userCanEditChild, auditSensitiveAccess } from '@/lib/supabase';
import { useAuth } from '@/components/providers/AuthProvider';
import type { 
  ChildWithRelation, 
  Child, 
  ChildInsert, 
  ChildUpdate, 
  ChildFilters,
  RelationInsert
} from '@/types';

interface UseChildrenOptions {
  includeInactive?: boolean;
  autoRefresh?: boolean;
  realtime?: boolean;
}

interface UseChildrenReturn {
  children: ChildWithRelation[];
  loading: boolean;
  error: string | null;
  createChild: (childData: ChildInsert) => Promise<Child>;
  updateChild: (id: string, updates: ChildUpdate) => Promise<Child>;
  deleteChild: (id: string) => Promise<void>;
  addUserToChild: (childId: string, userId: string, relation: RelationInsert) => Promise<void>;
  removeUserFromChild: (childId: string, userId: string) => Promise<void>;
  refreshChildren: () => Promise<void>;
  getChildById: (id: string) => ChildWithRelation | undefined;
  filterChildren: (filters: ChildFilters) => ChildWithRelation[];
  canEditChild: (childId: string) => Promise<boolean>;
  canAccessChild: (childId: string) => Promise<boolean>;
}

// ================================================================
// HELPER FUNCTIONS - Extraídas para reducir complejidad
// ================================================================

const getDefaultPrivacySettings = () => ({
  share_with_specialists: true,
  share_progress_reports: true,
  allow_photo_sharing: false,
  data_retention_months: 36
});

const transformChildData = (child: any, userId: string): ChildWithRelation => ({
  // Datos del niño
  id: child.id!,
  name: child.name!,
  birth_date: child.birth_date,
  diagnosis: child.diagnosis,
  notes: child.notes,
  is_active: child.is_active!,
  avatar_url: child.avatar_url,
  emergency_contact: child.emergency_contact ?? [],
  medical_info: child.medical_info ?? {},
  educational_info: child.educational_info ?? {},
  privacy_settings: child.privacy_settings ?? getDefaultPrivacySettings(),
  created_by: child.created_by!,
  created_at: child.created_at!,
  updated_at: child.updated_at!,
  
  // Datos de relación
  user_id: userId,
  relationship_type: child.relationship_type!,
  can_view: child.can_view!,
  can_edit: child.can_edit!,
  can_export: child.can_export!,
  can_invite_others: child.can_invite_others!,
  granted_at: child.granted_at!,
  expires_at: child.expires_at,
  is_relation_active: true,
  relation_created_at: child.granted_at!,
  relation_expires_at: child.expires_at,
  creator_name: child.creator_name ?? 'Usuario desconocido'
});

const handleAuditLog = async (action: string, userId: string, details: string) => {
  try {
    await auditSensitiveAccess(action, userId, details);
  } catch (auditError) {
    console.warn('⚠️ Audit error (ignored):', auditError);
  }
};

const prepareChildInsertData = (childData: ChildInsert, userId: string) => ({
  name: childData.name.trim(),
  created_by: userId,
  is_active: true,
  birth_date: childData.birth_date?.trim() ?? null,
  diagnosis: childData.diagnosis?.trim() ?? null,
  notes: childData.notes?.trim() ?? null,
  avatar_url: childData.avatar_url?.trim() ?? null,
  emergency_contact: Array.isArray(childData.emergency_contact) ? childData.emergency_contact : [],
  medical_info: {
    allergies: [],
    medications: [],
    conditions: [],
    emergency_notes: '',
    ...childData.medical_info
  },
  educational_info: {
    school: '',
    grade: '',
    teacher: '',
    iep_goals: [],
    accommodations: [],
    ...childData.educational_info
  },
  privacy_settings: {
    ...getDefaultPrivacySettings(),
    ...childData.privacy_settings
  }
});

const handleInsertError = (error: any) => {
  console.error('❌ Insert error:', error);
  
  if (error.code === '42501') {
    throw new Error('Sin permisos para crear niños. Verifica la configuración.');
  }
  if (error.code === '23505') {
    throw new Error('Ya existe un niño con datos similares.');
  }
  if (error.code === '23514') {
    throw new Error('Los datos no cumplen con las validaciones requeridas.');
  }
  throw new Error(`Error al crear niño: ${error.message}`);
};

const createParentRelation = async (supabase: any, userId: string, childId: string) => {
  try {
    const { error: relationError } = await supabase
      .from('user_child_relations')
      .insert({
        user_id: userId,
        child_id: childId,
        relationship_type: 'parent',
        can_edit: true,
        can_view: true,
        can_export: true,
        can_invite_others: true,
        granted_by: userId,
        granted_at: new Date().toISOString(),
        is_active: true,
        notes: 'Relación creada automáticamente como creador',
        notification_preferences: {
          email_alerts: true,
          weekly_reports: true
        }
      });

    if (relationError) {
      console.warn('⚠️ Relation creation failed (child created successfully):', relationError);
    } else {
      console.log('✅ Parent relation created successfully');
    }
  } catch (relationError) {
    console.warn('⚠️ Relation error (ignored):', relationError);
  }
};

// ================================================================
// HOOK PRINCIPAL REFACTORIZADO
// ================================================================

export function useChildren(options: UseChildrenOptions = {}): UseChildrenReturn {
  const {
    includeInactive = false,
    realtime = true
  } = options;

  const { user } = useAuth();
  const [children, setChildren] = useState<ChildWithRelation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Referencias estables
  const supabaseRef = useRef(createClient());
  const supabase = supabaseRef.current;
  const channelRef = useRef<any>(null);
  const mountedRef = useRef(true);

  // Memoizar userId
  const userId = useMemo(() => user?.id, [user?.id]);

  // Generar ID único para canal
  const channelId = useMemo(() => {
    return `children-${userId ?? 'anonymous'}-${Date.now()}`;
  }, [userId]);

  // ================================================================
  // FUNCIÓN FETCH CHILDREN REFACTORIZADA
  // ================================================================

  const fetchChildren = useCallback(async (): Promise<void> => {
    if (!userId) {
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);
      console.log('👶 Fetching children for user:', userId);

      const { data: childrenData, error: fetchError } = await supabase
        .from('user_accessible_children')
        .select('*')
        .order('created_at', { ascending: false });

      if (fetchError) {
        console.error('❌ Error fetching children:', fetchError);
        throw fetchError;
      }

      if (!mountedRef.current) return;

      console.log('✅ Children data fetched:', childrenData?.length ?? 0);

      // Transformar datos usando helper
      const transformedChildren: ChildWithRelation[] = (childrenData ?? [])
        .map(child => transformChildData(child, userId));

      setChildren(transformedChildren);
      console.log('✅ Children processed successfully:', transformedChildren.length);

      // Auditoría usando helper
      if (transformedChildren.length > 0) {
        await handleAuditLog(
          'VIEW_CHILDREN_LIST',
          userId,
          `Accessed ${transformedChildren.length} children profiles`
        );
      }

    } catch (err) {
      console.error('❌ Error in fetchChildren:', err);
      if (mountedRef.current) {
        const errorMessage = err instanceof Error ? err.message : 'Error al cargar niños';
        setError(errorMessage);
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [userId, includeInactive, supabase]);

  // ================================================================
  // FUNCIÓN CREATE CHILD REFACTORIZADA
  // ================================================================

  const createChild = useCallback(async (childData: ChildInsert): Promise<Child> => {
    if (!userId) {
      throw new Error('Usuario no autenticado');
    }

    try {
      setLoading(true);
      setError(null);
      console.log('🚀 Creating child...');

      // Verificar sesión
      const { data: session } = await supabase.auth.getSession();
      if (!session?.session) {
        throw new Error('Sesión inválida. Inicia sesión nuevamente.');
      }

      // Preparar datos usando helper
      const insertData = prepareChildInsertData(childData, userId);

      // Insertar niño
      const { data: newChild, error: insertError } = await supabase
        .from('children')
        .insert(insertData)
        .select(`
          *,
          creator:profiles!created_by (
            full_name
          )
        `)
        .single();

      if (insertError) {
        handleInsertError(insertError);
      }

      if (!newChild) {
        throw new Error('No se recibieron datos después de crear el niño');
      }

      console.log('✅ Child created successfully:', newChild.name);

      // Crear relación usando helper
      await createParentRelation(supabase, userId, newChild.id);

      // Refrescar lista
      await fetchChildren();
      
      // Auditoría usando helper
      await handleAuditLog(
        'CREATE_CHILD',
        newChild.id,
        `Created child: ${newChild.name}`
      );

      return newChild;

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Error al crear niño';
      console.error('❌ Final error in createChild:', errorMessage);
      setError(errorMessage);
      throw new Error(errorMessage);
    } finally {
      setLoading(false);
    }
  }, [userId, supabase, fetchChildren]);

  // ================================================================
  // RESTO DE FUNCIONES (sin cambios significativos)
  // ================================================================

  const updateChild = useCallback(async (id: string, updates: ChildUpdate): Promise<Child> => {
    if (!userId) {
      throw new Error('Usuario no autenticado');
    }

    try {
      setLoading(true);
      setError(null);

      const canEdit = await userCanEditChild(id, userId);
      if (!canEdit) {
        throw new Error('No tienes permisos para editar este niño');
      }

      const { data, error } = await supabase
        .from('children')
        .update({
          ...updates,
          updated_at: new Date().toISOString()
        })
        .eq('id', id)
        .select()
        .single();

      if (error) throw error;

      await fetchChildren();
      
      await handleAuditLog(
        'UPDATE_CHILD',
        data.id,
        `Updated child: ${data.name}`
      );

      return data;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Error al actualizar niño';
      setError(errorMessage);
      throw new Error(errorMessage);
    } finally {
      setLoading(false);
    }
  }, [userId, supabase, fetchChildren]);

  const deleteChild = useCallback(async (id: string): Promise<void> => {
    if (!userId) {
      throw new Error('Usuario no autenticado');
    }

    try {
      setLoading(true);
      
      const { error } = await supabase
        .from('children')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('id', id)
        .eq('created_by', userId);

      if (error) throw error;

      await fetchChildren();
      
      await handleAuditLog(
        'DELETE_CHILD',
        id,
        'Child marked as inactive'
      );
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Error al eliminar niño';
      setError(errorMessage);
      throw new Error(errorMessage);
    } finally {
      setLoading(false);
    }
  }, [userId, supabase, fetchChildren]);

  const refreshChildren = useCallback(async (): Promise<void> => {
    await fetchChildren();
  }, [fetchChildren]);

  const getChildById = useCallback((id: string): ChildWithRelation | undefined => {
    return children.find(child => child.id === id);
  }, [children]);

  const filterChildren = useCallback((filters: ChildFilters): ChildWithRelation[] => {
    return children.filter(child => {
      if (filters.search && !child.name.toLowerCase().includes(filters.search.toLowerCase())) {
        return false;
      }
      
      if (filters.relationship_type && child.relationship_type !== filters.relationship_type) {
        return false;
      }
      
      if (filters.is_active !== undefined && child.is_active !== filters.is_active) {
        return false;
      }
      
      if (filters.has_diagnosis !== undefined) {
        const hasDiagnosis = !!child.diagnosis;
        if (hasDiagnosis !== filters.has_diagnosis) {
          return false;
        }
      }
      
      if (filters.max_age && child.birth_date) {
        const age = new Date().getFullYear() - new Date(child.birth_date).getFullYear();
        if (age > filters.max_age) {
          return false;
        }
      }
      
      return true;
    });
  }, [children]);

  const canEditChild = useCallback(async (childId: string): Promise<boolean> => {
    return userCanEditChild(childId, userId);
  }, [userId]);

  const canAccessChild = useCallback(async (childId: string): Promise<boolean> => {
    return userCanAccessChild(childId, userId);
  }, [userId]);

  const addUserToChild = useCallback(async (): Promise<void> => {
    throw new Error('Función no implementada aún');
  }, []);

  const removeUserFromChild = useCallback(async (): Promise<void> => {
    throw new Error('Función no implementada aún');
  }, []);

  // ================================================================
  // EFFECTS (sin cambios)
  // ================================================================

  useEffect(() => {
    mountedRef.current = true;
    
    if (userId) {
      fetchChildren();
    } else {
      setChildren([]);
      setLoading(false);
    }

    return () => {
      mountedRef.current = false;
    };
  }, [userId, fetchChildren]);

  useEffect(() => {
    if (!realtime || !userId) return;

    if (channelRef.current) {
      supabase.removeChannel(channelRef.current);
      channelRef.current = null;
    }

    console.log('🔄 Setting up realtime subscription:', channelId);

    const channel = supabase
      .channel(channelId)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'children'
      }, (payload) => {
        console.log('🔄 Children realtime update:', payload.eventType);
        if (mountedRef.current) {
          fetchChildren();
        }
      })
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'user_child_relations'
      }, (payload) => {
        console.log('🔄 Relations realtime update:', payload.eventType);
        if (mountedRef.current) {
          fetchChildren();
        }
      })
      .subscribe((status) => {
        console.log('📡 Realtime status:', status);
      });

    channelRef.current = channel;

    return () => {
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
    };
  }, [realtime, userId, channelId, supabase, fetchChildren]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
    };
  }, [supabase]);

  return {
    children,
    loading,
    error,
    createChild,
    updateChild,
    deleteChild,
    addUserToChild,
    removeUserFromChild,
    refreshChildren,
    getChildById,
    filterChildren,
    canEditChild,
    canAccessChild
  };
}
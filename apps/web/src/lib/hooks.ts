import { useQuery } from '@tanstack/react-query';
import { endpoints } from './api';

export const useMe = () => useQuery({ queryKey: ['me'], queryFn: endpoints.me, retry: false, staleTime: 60_000 });
export const useDestinations = () => useQuery({ queryKey: ['destinations'], queryFn: endpoints.destinations });
